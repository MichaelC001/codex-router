import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  INVALID_FUNCTION_CALL_ARGUMENTS_CODE,
  InvalidCompletedFunctionCallTransform,
  InvalidFunctionCallArgumentsError,
  findUnusableCompletedFunctionCall,
  findUnusableFunctionCallArguments,
  functionCallArgumentsAreJson,
  functionToolInventory,
  omitUnexecutedEmptyArgumentCalls,
  toolTakesNoInputs,
  historyFunctionCallArgumentsError,
  isLocalToolArgumentConversionFailure,
  localToolArgumentConversionError,
} from "../src/invalid-function-call.mjs";

const UNTERMINATED = '{"cmd":"echo hello';
const VALID = '{"cmd":"echo hello"}';

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function collect(transform, chunks) {
  const output = [];
  await pipeline(
    Readable.from(chunks),
    transform,
    new Writable({
      write(chunk, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(output);
}

async function collectUntilError(transform, chunks) {
  const output = [];
  let error;
  try {
    await pipeline(
      Readable.from(chunks),
      transform,
      new Writable({
        write(chunk, _encoding, callback) {
          output.push(Buffer.from(chunk));
          callback();
        },
      }),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "the transform should fail the completed invalid call");
  return { output: Buffer.concat(output), error };
}

test("functionCallArgumentsAreJson allows empty, objects, and parseable JSON", () => {
  assert.equal(functionCallArgumentsAreJson(""), true);
  assert.equal(functionCallArgumentsAreJson("   "), true);
  assert.equal(functionCallArgumentsAreJson(VALID), true);
  assert.equal(functionCallArgumentsAreJson("[]"), true);
  assert.equal(functionCallArgumentsAreJson({ cmd: "x" }), true);
  assert.equal(functionCallArgumentsAreJson(UNTERMINATED), false);
  assert.equal(functionCallArgumentsAreJson("{"), false);
});

test("findUnusableFunctionCallArguments names the stored call and omits the body", () => {
  const found = findUnusableFunctionCallArguments([
    { type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
    {
      type: "function_call",
      name: "exec_command",
      call_id: "call_abc",
      id: "fc_abc",
      arguments: UNTERMINATED,
    },
  ]);
  assert.equal(found.toolName, "exec_command");
  assert.equal(found.callId, "call_abc");
  assert.equal(found.param, "input[1]");
  assert.match(found.jsonError, /Unterminated string|Unexpected end/i);
  const payload = historyFunctionCallArgumentsError(found);
  assert.equal(payload.error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.equal(payload.error.type, "invalid_request_error");
  assert.match(payload.error.message, /not a provider rejection/);
  assert.match(payload.error.message, /exec_command/);
  assert.match(payload.error.message, /call_abc/);
  assert.doesNotMatch(payload.error.message, /echo hello/);
});

test("findUnusableFunctionCallArguments inspects chat-shaped tool_calls", () => {
  const found = findUnusableFunctionCallArguments([
    {
      type: "message",
      role: "assistant",
      tool_calls: [
        {
          id: "call_chat",
          function: { name: "exec_command", arguments: UNTERMINATED },
        },
      ],
    },
  ]);
  assert.equal(found.toolName, "exec_command");
  assert.equal(found.callId, "call_chat");
  assert.equal(found.param, "input[0].tool_calls[0]");
});

test("findUnusableFunctionCallArguments ignores valid, empty, and custom tool calls", () => {
  assert.equal(
    findUnusableFunctionCallArguments([
      { type: "function_call", name: "exec_command", arguments: VALID },
      { type: "function_call", name: "exec_command", arguments: "" },
      { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch" },
      { type: "message", role: "user", content: "hi" },
    ]),
    undefined,
  );
  assert.equal(findUnusableFunctionCallArguments("just a prompt"), undefined);
});

test("duplicate-key JSON still parses, so history is not refused", () => {
  assert.equal(
    findUnusableFunctionCallArguments([
      { type: "function_call", name: "exec_command", arguments: '{"a":1,"a":2}' },
    ]),
    undefined,
  );
});

test("a raw-codec function_call keeps malformed arguments for the native hook", () => {
  const lookups = {
    customCodecs: new Map([["apply_patch", { preserveRawArguments: true }]]),
  };
  assert.equal(
    findUnusableFunctionCallArguments(
      [{ type: "function_call", name: "apply_patch", arguments: "*** Begin Patch" }],
      { lookups },
    ),
    undefined,
  );
});

test("isLocalToolArgumentConversionFailure matches LiteLLM's Anthropic invoke error", () => {
  const body = JSON.stringify({
    error: {
      message:
        "Failed to parse tool call arguments for tool 'exec_command' (Anthropic tool invoke). " +
        "Error: Unterminated string starting at: line 1 column 8 (char 7).\n" +
        '{"cmd":"usage limit reached for your GLM Coding Plan"}',
    },
  });
  assert.equal(isLocalToolArgumentConversionFailure(body), true);
  const translated = localToolArgumentConversionError(body);
  assert.equal(translated.error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.match(translated.error.message, /exec_command/);
  assert.match(translated.error.message, /not a provider rejection/);
  assert.doesNotMatch(translated.error.message, /usage limit reached/);
  assert.doesNotMatch(translated.error.message, /opencode rejected/);
  assert.equal(isLocalToolArgumentConversionFailure("insufficient_quota"), false);
});

test("a completed unterminated function_call fails before the done frame is relayed", async () => {
  const added = sse({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec_command",
      arguments: "",
    },
  });
  const delta = sse({
    type: "response.function_call_arguments.delta",
    item_id: "fc_1",
    delta: UNTERMINATED,
  });
  const done = sse({
    type: "response.function_call_arguments.done",
    item_id: "fc_1",
    call_id: "call_1",
    arguments: UNTERMINATED,
  });
  const closed = sse({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "exec_command",
      arguments: UNTERMINATED,
    },
  });
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(),
    [Buffer.from(added + delta + done + closed, "utf8")],
  );
  assert.equal(error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.ok(error instanceof InvalidFunctionCallArgumentsError);
  assert.equal(error.status, 502);
  assert.match(error.message, /exec_command/);
  assert.match(error.message, /did not relay the completed item/);
  const text = output.toString("utf8");
  assert.doesNotMatch(text, /output_item\.added/);
  assert.doesNotMatch(text, /function_call_arguments\.delta/);
  assert.doesNotMatch(text, /function_call_arguments\.done/);
  assert.doesNotMatch(text, /output_item\.done/);
});

test("a done frame without a name still fails and names the tool from added", async () => {
  const added = sse({
    type: "response.output_item.added",
    item: {
      type: "function_call",
      id: "fc_anon",
      call_id: "call_anon",
      name: "exec_command",
      arguments: "",
    },
  });
  const done = sse({
    type: "response.function_call_arguments.done",
    item_id: "fc_anon",
    call_id: "call_anon",
    arguments: UNTERMINATED,
  });
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(),
    [Buffer.from(added + done, "utf8")],
  );
  assert.equal(error.toolName, "exec_command");
  assert.match(error.message, /exec_command/);
  assert.doesNotMatch(output.toString("utf8"), /output_item\.added/);
  assert.doesNotMatch(output.toString("utf8"), /function_call_arguments\.done/);
});

test("a valid completed function_call stream is byte-identical", async () => {
  const source = [
    sse({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_ok",
        call_id: "call_ok",
        name: "exec_command",
        arguments: "",
      },
    }),
    sse({
      type: "response.function_call_arguments.done",
      item_id: "fc_ok",
      arguments: VALID,
    }),
    sse({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_ok",
        call_id: "call_ok",
        name: "exec_command",
        arguments: VALID,
      },
    }),
  ].join("");
  const output = await collect(
    new InvalidCompletedFunctionCallTransform(),
    [Buffer.from(source, "utf8")],
  );
  assert.equal(output.toString("utf8"), source);
});

test("raw-codec malformed arguments still pass through the stream transform", async () => {
  const source = sse({
    type: "response.function_call_arguments.done",
    item_id: "fc_patch",
    name: "apply_patch",
    arguments: "*** Begin Patch\n*** End Patch",
  });
  const output = await collect(
    new InvalidCompletedFunctionCallTransform({
      customCodecs: new Map([["apply_patch", { preserveRawArguments: true }]]),
    }),
    [Buffer.from(source, "utf8")],
  );
  assert.equal(output.toString("utf8"), source);
});

test("a non-streaming completed response with unterminated arguments is refused", async () => {
  const payload = {
    output: [
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_json",
        arguments: UNTERMINATED,
      },
    ],
  };
  assert.equal(
    findUnusableCompletedFunctionCall(payload)?.toolName,
    "exec_command",
  );
  const body = JSON.stringify(payload);
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(undefined, false),
    [Buffer.from(body, "utf8")],
  );
  assert.equal(error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.equal(output.length, 0);
});

const EXEC_TOOL = {
  type: "function",
  name: "exec_command",
  parameters: {
    type: "object",
    properties: { cmd: { type: "string" } },
    required: ["cmd"],
  },
};
const NO_INPUT_TOOL = {
  type: "function",
  name: "list_mcp_resources_now",
  parameters: { type: "object", properties: {} },
};
const NAMESPACE_TOOL = {
  type: "namespace",
  name: "mcp__clock__",
  tools: [
    { type: "function", name: "now", parameters: { type: "object", properties: {}, required: [] } },
    { type: "function", name: "convert", parameters: { type: "object", properties: { tz: { type: "string" } } } },
  ],
};
const PARSE_EOF = "failed to parse function arguments: EOF while parsing a value at line 1 column 0";

function emptyArgumentStream(item) {
  const added = sse({ type: "response.output_item.added", item: { ...item, arguments: "" } });
  const done = sse({
    type: "response.function_call_arguments.done",
    item_id: item.id,
    call_id: item.call_id,
    arguments: "",
  });
  const closed = sse({ type: "response.output_item.done", item: { ...item, arguments: "" } });
  return [Buffer.from(added + done + closed, "utf8")];
}

test("toolTakesNoInputs accepts only schemas without inputs", () => {
  assert.equal(toolTakesNoInputs(undefined), true);
  assert.equal(toolTakesNoInputs({ type: "object" }), true);
  assert.equal(toolTakesNoInputs({ type: "object", properties: {}, required: [] }), true);
  assert.equal(toolTakesNoInputs(EXEC_TOOL.parameters), false);
  assert.equal(toolTakesNoInputs({ type: "object", properties: { a: { type: "string" } } }), false);
  assert.equal(toolTakesNoInputs({ type: "object", anyOf: [{ required: ["a"] }] }), false);
  assert.equal(toolTakesNoInputs({ type: "string" }), false);
});

test("functionToolInventory reads declared, namespaced, and tool_search tools", () => {
  const inventory = functionToolInventory([EXEC_TOOL, NO_INPUT_TOOL, NAMESPACE_TOOL], [
    { type: "tool_search_output", tools: [{ type: "function", name: "loaded_ping" }] },
  ]);
  assert.equal(inventory.get("\u0000exec_command"), false);
  assert.equal(inventory.get("\u0000list_mcp_resources_now"), true);
  assert.equal(inventory.get("mcp__clock__\u0000now"), true);
  assert.equal(inventory.get("mcp__clock__\u0000convert"), false);
  assert.equal(inventory.get("\u0000mcp__clock____now"), true);
  assert.equal(inventory.get("\u0000loaded_ping"), true);
});

test("completed empty arguments are refused for a tool that takes inputs (#1066)", async () => {
  const tools = functionToolInventory([EXEC_TOOL]);
  const { output, error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(undefined, true, tools),
    emptyArgumentStream({ type: "function_call", id: "fc_e", call_id: "call_e", name: "exec_command" }),
  );
  assert.equal(error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
  assert.match(error.message, /exec_command/);
  const text = output.toString("utf8");
  assert.doesNotMatch(text, /output_item\.done/);
  assert.doesNotMatch(text, /function_call_arguments\.done/);
});

test("whitespace-only arguments count as empty", () => {
  const tools = functionToolInventory([EXEC_TOOL]);
  const found = findUnusableCompletedFunctionCall({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "c", name: "exec_command", arguments: "  \n" },
  }, { tools });
  assert.ok(found);
});

test("completed empty arguments are refused for a tool nobody declared", () => {
  const tools = functionToolInventory([EXEC_TOOL]);
  assert.ok(findUnusableCompletedFunctionCall({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "c", name: "imagined_tool", arguments: "" },
  }, { tools }));
});

test("empty arguments stay valid for a no-input tool, flat or namespaced", async () => {
  const tools = functionToolInventory([EXEC_TOOL, NO_INPUT_TOOL, NAMESPACE_TOOL]);
  for (const item of [
    { type: "function_call", id: "fc_a", call_id: "call_a", name: "list_mcp_resources_now" },
    { type: "function_call", id: "fc_b", call_id: "call_b", name: "now", namespace: "mcp__clock__" },
  ]) {
    const chunks = emptyArgumentStream(item);
    const output = await collect(new InvalidCompletedFunctionCallTransform(undefined, true, tools), chunks);
    assert.equal(Buffer.concat([].concat(output)).toString("utf8"), chunks[0].toString("utf8"));
  }
  assert.ok(findUnusableCompletedFunctionCall({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "c", name: "convert", namespace: "mcp__clock__", arguments: "" },
  }, { tools }));
});

test("the opening frame and in-progress snapshots may carry empty arguments", () => {
  const tools = functionToolInventory([EXEC_TOOL]);
  const item = { type: "function_call", call_id: "c", name: "exec_command", arguments: "" };
  assert.equal(findUnusableCompletedFunctionCall({ type: "response.output_item.added", item }, { tools }), undefined);
  assert.equal(findUnusableCompletedFunctionCall({
    type: "response.in_progress",
    response: { output: [item] },
  }, { tools }), undefined);
  assert.ok(findUnusableCompletedFunctionCall({
    type: "response.completed",
    response: { output: [{ ...item, status: "completed" }] },
  }, { tools }));
});

test("a non-streaming response with empty arguments for an input tool is refused", async () => {
  const tools = functionToolInventory([EXEC_TOOL]);
  const body = JSON.stringify({
    status: "completed",
    output: [{ type: "function_call", call_id: "c", name: "exec_command", arguments: "" }],
  });
  const { error } = await collectUntilError(
    new InvalidCompletedFunctionCallTransform(undefined, false, tools),
    [Buffer.from(body)],
  );
  assert.equal(error.code, INVALID_FUNCTION_CALL_ARGUMENTS_CODE);
});

test("history refuses empty arguments only for a tool known to take inputs", () => {
  const tools = functionToolInventory([EXEC_TOOL, NO_INPUT_TOOL]);
  const found = findUnusableFunctionCallArguments([
    { type: "function_call", call_id: "c1", name: "exec_command", arguments: "" },
    { type: "function_call_output", call_id: "c1", output: "something else" },
  ], { tools });
  assert.equal(found?.toolName, "exec_command");
  assert.equal(findUnusableFunctionCallArguments([
    { type: "function_call", call_id: "c2", name: "list_mcp_resources_now", arguments: "" },
    { type: "function_call", call_id: "c3", name: "removed_since", arguments: "" },
  ], { tools }), undefined);
});

test("omitUnexecutedEmptyArgumentCalls drops only the poisoned pair", () => {
  const keep = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "ok", name: "exec_command", arguments: VALID },
    { type: "function_call_output", call_id: "ok", output: "done" },
    { type: "function_call", call_id: "other", name: "exec_command", arguments: "" },
    { type: "function_call_output", call_id: "other", output: "real tool output" },
  ];
  const poisoned = [
    { type: "function_call", call_id: "bad", name: "exec_command", arguments: "" },
    { type: "function_call_output", call_id: "bad", output: PARSE_EOF },
    { type: "function_call", call_id: "bad2", name: "exec_command", arguments: "" },
    { type: "function_call_output", call_id: "bad2", output: [{ type: "input_text", text: PARSE_EOF }] },
  ];
  const result = omitUnexecutedEmptyArgumentCalls([...keep, ...poisoned]);
  assert.equal(result.omitted, 2);
  assert.deepEqual(result.input, keep);
  const untouched = [...keep];
  assert.equal(omitUnexecutedEmptyArgumentCalls(untouched).input, untouched);
});
