import { Transform } from "node:stream";

import { NAMESPACE_DELIMITER, buildNamespaceLookups } from "./namespace-relay.mjs";

// A completed `function_call` whose arguments are not JSON is unusable: Codex
// cannot execute it, stores it, and every later turn on that thread then fails
// (#797). LiteLLM's Anthropic converter raises the same parse as a provider 400
// (#796), so history that is already poisoned looks like an upstream rejection
// and can even trip failover when the argument body matches a quota phrase.
//
// Repair is not the answer -- closing an unterminated string would invent
// command bytes. Fail the turn instead, and never attribute a local conversion
// of stored history to the provider.

export const INVALID_FUNCTION_CALL_ARGUMENTS_CODE = "invalid_function_call_arguments";

const CRLF_SEP = Buffer.from("\r\n\r\n");
const LF_SEP = Buffer.from("\n\n");
const MAX_SSE_FRAME_BYTES = 10 * 1024 * 1024;
const MAX_JSON_CAPTURE_BYTES = 10 * 1024 * 1024;
const TOOL_NAME_IN_CONVERSION =
  /Failed to parse tool call arguments for tool ['"]?([^'"\s]+)['"]?/i;

export class InvalidFunctionCallArgumentsError extends Error {
  constructor({ source, toolName, callId, itemId, param, jsonError } = {}) {
    super(invalidFunctionCallArgumentsMessage({
      source,
      toolName,
      callId,
      itemId,
      param,
      jsonError,
    }));
    this.name = "InvalidFunctionCallArgumentsError";
    this.code = INVALID_FUNCTION_CALL_ARGUMENTS_CODE;
    this.status = source === "history" ? 400 : 502;
    this.source = source === "history" ? "history" : "response";
    this.param = param ?? null;
    this.toolName = toolName;
    this.callId = callId;
    this.itemId = itemId;
  }
}

export function functionCallArgumentsAreJson(value, { allowEmpty = true } = {}) {
  if (typeof value !== "string") return true;
  if (allowEmpty && value.trim() === "") return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

// An empty argument string is how a model calls a tool that takes no inputs
// (MCP tools without parameters send exactly that), so it stays legal there.
// For every other tool a *completed* call with empty arguments is as unusable
// as truncated JSON: Codex fails to parse it, stores the pair, and each later
// turn is rejected (#1066). Opening and partial frames may still be empty.
function blankArguments(value) {
  return typeof value === "string" && value.trim() === "";
}

export function toolTakesNoInputs(parameters) {
  if (parameters === undefined || parameters === null) return true;
  if (typeof parameters !== "object" || Array.isArray(parameters)) return false;
  if (parameters.type !== undefined && parameters.type !== "object") return false;
  for (const key of ["anyOf", "oneOf", "allOf", "patternProperties"]) {
    if (parameters[key] !== undefined) return false;
  }
  const properties = parameters.properties;
  if (properties !== undefined && (typeof properties !== "object" || properties === null ||
    Object.keys(properties).length > 0)) return false;
  if (Array.isArray(parameters.required) && parameters.required.length > 0) return false;
  return true;
}

function toolKey(namespace, name) {
  return `${typeof namespace === "string" ? namespace : ""}\u0000${name}`;
}

function collectToolInventory(tools, inventory, namespace) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      collectToolInventory(tool.tools, inventory, tool.name);
      continue;
    }
    const name = typeof tool.name === "string" && tool.name
      ? tool.name
      : typeof tool.function?.name === "string" ? tool.function.name : undefined;
    if (!name || (tool.type !== undefined && tool.type !== "function")) continue;
    const noInputs = toolTakesNoInputs(tool.parameters ?? tool.function?.parameters);
    const spellings = namespace
      ? [toolKey(namespace, name), toolKey(undefined, `${namespace}${NAMESPACE_DELIMITER}${name}`),
        toolKey(undefined, `${namespace}.${name}`)]
      : [toolKey(undefined, name)];
    for (const key of spellings) {
      // A name declared both ways is not provably input-free.
      inventory.set(key, (inventory.get(key) ?? true) && noInputs);
    }
  }
}

// Every function the client declared this turn, plus definitions that an
// earlier client-executed tool_search loaded into history, mapped to whether
// that function takes no inputs.
export function functionToolInventory(tools, input) {
  const inventory = new Map();
  collectToolInventory(tools, inventory);
  if (Array.isArray(input)) {
    for (const item of input) {
      if (item?.type === "tool_search_output") collectToolInventory(item.tools, inventory);
    }
  }
  return inventory;
}

function blankArgumentsAllowed(item, inventory, { unknownAllowed }) {
  if (!(inventory instanceof Map)) return true;
  const name = typeof item?.name === "string" ? item.name : undefined;
  if (!name) return unknownAllowed;
  const namespaced = typeof item.namespace === "string" && item.namespace
    ? inventory.get(toolKey(item.namespace, name))
    : undefined;
  const known = namespaced ?? inventory.get(toolKey(undefined, name));
  if (known === undefined) return unknownAllowed;
  return known;
}

const UNEXECUTED_EMPTY_ARGUMENTS_OUTPUT =
  "failed to parse function arguments: EOF while parsing a value at line 1 column 0";

function functionCallOutputText(output) {
  if (typeof output === "string") return output;
  const parts = Array.isArray(output) ? output : Array.isArray(output?.content) ? output.content : undefined;
  if (!parts || parts.length !== 1) return undefined;
  return typeof parts[0]?.text === "string" ? parts[0].text : undefined;
}

// History that is already poisoned by #1066 holds a function_call with empty
// arguments and Codex's own parse failure as its only output, which proves the
// call never ran. Omit exactly those pairs from the forwarded request; never
// invent arguments, and leave every other malformed pair to be refused.
export function omitUnexecutedEmptyArgumentCalls(input) {
  if (!Array.isArray(input)) return { input, omitted: 0 };
  const outputsByCallId = new Map();
  for (const item of input) {
    if (item?.type !== "function_call_output" || typeof item.call_id !== "string") continue;
    outputsByCallId.set(item.call_id, (outputsByCallId.get(item.call_id) || []).concat([item]));
  }
  const drop = new Set();
  const callIdsSeen = new Map();
  for (const item of input) {
    if (item?.type === "function_call" && typeof item.call_id === "string") {
      callIdsSeen.set(item.call_id, (callIdsSeen.get(item.call_id) || 0) + 1);
    }
  }
  for (const item of input) {
    if (item?.type !== "function_call" || !blankArguments(item.arguments)) continue;
    if (typeof item.call_id !== "string" || callIdsSeen.get(item.call_id) !== 1) continue;
    const outputs = outputsByCallId.get(item.call_id) || [];
    if (outputs.length !== 1) continue;
    if (functionCallOutputText(outputs[0].output)?.trim() !== UNEXECUTED_EMPTY_ARGUMENTS_OUTPUT) continue;
    drop.add(item);
    drop.add(outputs[0]);
  }
  if (!drop.size) return { input, omitted: 0 };
  return { input: input.filter((item) => !drop.has(item)), omitted: drop.size / 2 };
}

export function preservesRawFunctionCallArguments(item, lookups) {
  return item?.type === "function_call" &&
    item.namespace === undefined &&
    lookups?.customCodecs?.get(item.name)?.preserveRawArguments === true;
}

export function describeFunctionCallIdentity(item, { path } = {}) {
  const toolName = typeof item?.name === "string" && item.name
    ? item.name
    : typeof item?.function?.name === "string" && item.function.name
      ? item.function.name
      : undefined;
  const callId = typeof item?.call_id === "string" && item.call_id
    ? item.call_id
    : typeof item?.id === "string" && item.id
      ? item.id
      : undefined;
  const itemId = typeof item?.id === "string" && item.id ? item.id : undefined;
  return { toolName, callId, itemId, param: path };
}

function jsonParseError(value) {
  try {
    JSON.parse(value);
    return undefined;
  } catch (error) {
    return error?.message || "Invalid JSON";
  }
}

function inspectFunctionCallArguments(
  item,
  { path, lookups, tools, completed = false, unknownAllowed = false } = {},
) {
  if (item?.type === "custom_tool_call") return undefined;
  if (preservesRawFunctionCallArguments(item, lookups)) return undefined;
  const argumentsText = typeof item?.arguments === "string"
    ? item.arguments
    : typeof item?.function?.arguments === "string"
      ? item.function.arguments
      : undefined;
  if (typeof argumentsText !== "string") return undefined;
  if (blankArguments(argumentsText)) {
    if (!completed) return undefined;
    const identity = item?.name === undefined && typeof item?.function?.name === "string"
      ? { ...item, name: item.function.name }
      : item;
    if (blankArgumentsAllowed(identity, tools, { unknownAllowed })) return undefined;
    return {
      ...describeFunctionCallIdentity(item, { path }),
      jsonError: "empty arguments for a tool that takes inputs",
    };
  }
  if (functionCallArgumentsAreJson(argumentsText)) return undefined;
  return {
    ...describeFunctionCallIdentity(item, { path }),
    jsonError: jsonParseError(argumentsText),
  };
}

function inspectChatToolCall(call, path, options) {
  if (!call || typeof call !== "object") return undefined;
  return inspectFunctionCallArguments(
    {
      type: "function_call",
      name: call.function?.name ?? call.name,
      arguments: call.function?.arguments ?? call.arguments,
      call_id: call.call_id ?? call.id,
      id: call.id,
    },
    { ...options, path },
  );
}

// Stored history: a tool absent from this turn's inventory may have been
// removed since it ran, so only a call to a tool known to take inputs is
// refused for empty arguments.
export function findUnusableFunctionCallArguments(input, { lookups, tools } = {}) {
  if (!Array.isArray(input)) return undefined;
  const options = { lookups, tools, completed: true, unknownAllowed: true };
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const found = inspectFunctionCallArguments(item, {
      ...options,
      path: `input[${index}]`,
    });
    if (found) return found;
    const toolCalls = item?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
      const nested = inspectChatToolCall(
        toolCalls[callIndex],
        `input[${index}].tool_calls[${callIndex}]`,
        options,
      );
      if (nested) return nested;
    }
  }
  return undefined;
}

function inspectOutputItems(output, lookups, tools, completed) {
  if (!Array.isArray(output)) return undefined;
  for (let index = 0; index < output.length; index += 1) {
    const found = inspectFunctionCallArguments(output[index], {
      path: `output[${index}]`,
      lookups,
      tools,
      completed: completed && output[index]?.status !== "in_progress",
    });
    if (found) return found;
  }
  return undefined;
}

// A model can only call what it was offered, so in a response an empty
// argument string is accepted only for a declared tool that takes no inputs.
// Without an inventory (`tools` undefined) empty arguments stay accepted.
export function findUnusableCompletedFunctionCall(event, { lookups, tools } = {}) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "response.function_call_arguments.done") {
    return inspectFunctionCallArguments(
      {
        type: "function_call",
        name: event.name,
        arguments: event.arguments,
        call_id: event.call_id,
        id: event.item_id,
        namespace: event.namespace,
      },
      { path: "function_call_arguments.done", lookups, tools, completed: true },
    );
  }
  if (event.type === "response.output_item.done") {
    return inspectFunctionCallArguments(event.item, {
      path: "output_item.done",
      lookups,
      tools,
      completed: true,
    });
  }
  if (event.type === "response.completed" || event.type === "response.done") {
    return inspectOutputItems(event.response?.output ?? event.output, lookups, tools, true) ||
      inspectOutputItems(event.output, lookups, tools, true);
  }
  // A non-streaming body has no event type; it is the finished response
  // unless it says otherwise. Typed in-progress snapshots may hold openings.
  const finishedBody = event.type === undefined && event.status !== "in_progress";
  if (Array.isArray(event.output)) {
    return inspectOutputItems(event.output, lookups, tools, finishedBody);
  }
  if (Array.isArray(event.response?.output)) {
    return inspectOutputItems(event.response.output, lookups, tools, finishedBody);
  }
  return undefined;
}

function identityClause({ toolName, callId, itemId, param }) {
  const parts = [];
  if (toolName) parts.push(`tool '${toolName}'`);
  if (callId) parts.push(`call_id '${callId}'`);
  else if (itemId) parts.push(`item '${itemId}'`);
  if (param) parts.push(param);
  return parts.length ? ` ${parts.join(", ")}.` : ".";
}

export function invalidFunctionCallArgumentsMessage({
  source,
  toolName,
  callId,
  itemId,
  param,
  jsonError,
} = {}) {
  const identity = identityClause({ toolName, callId, itemId, param });
  const parse = jsonError ? ` (${jsonError})` : "";
  if (source === "history") {
    return (
      "The local router refused this request because a stored function_call has " +
      `arguments that are not valid JSON, so the turn cannot be sent.${identity}` +
      " This is a broken history item from an earlier response, not a provider rejection." +
      parse
    );
  }
  return (
    "The model completed a function_call whose arguments are not valid JSON." +
    identity +
    " The router did not relay the completed item, because the client cannot execute it " +
    "and storing it would break later turns." +
    parse
  );
}

export function isInvalidFunctionCallArgumentsError(error) {
  return error instanceof InvalidFunctionCallArgumentsError
    || error?.code === INVALID_FUNCTION_CALL_ARGUMENTS_CODE;
}

function functionCallHoldId(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
    return typeof event.item.id === "string" && event.item.id ? event.item.id : undefined;
  }
  if (
    event.type === "response.function_call_arguments.delta"
    || event.type === "response.function_call_arguments.done"
  ) {
    return typeof event.item_id === "string" && event.item_id ? event.item_id : undefined;
  }
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    return typeof event.item.id === "string" && event.item.id ? event.item.id : undefined;
  }
  return undefined;
}

function isFunctionCallCompletion(event) {
  return event?.type === "response.function_call_arguments.done"
    || (event?.type === "response.output_item.done" && event.item?.type === "function_call");
}

export function historyFunctionCallArgumentsError(invalid) {
  const error = new InvalidFunctionCallArgumentsError({
    source: "history",
    ...invalid,
  });
  return {
    error: {
      message: error.message,
      type: "invalid_request_error",
      param: error.param,
      code: INVALID_FUNCTION_CALL_ARGUMENTS_CODE,
    },
  };
}

export function isLocalToolArgumentConversionFailure(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return false;
  return TOOL_NAME_IN_CONVERSION.test(bodyText) ||
    /\(Anthropic tool invoke\)/.test(bodyText);
}

export function localToolArgumentConversionError(bodyText) {
  const match = typeof bodyText === "string"
    ? bodyText.match(TOOL_NAME_IN_CONVERSION)
    : undefined;
  const toolName = match?.[1];
  return {
    error: {
      message: invalidFunctionCallArgumentsMessage({
        source: "history",
        toolName,
      }),
      type: "invalid_request_error",
      param: null,
      code: INVALID_FUNCTION_CALL_ARGUMENTS_CODE,
    },
  };
}

function fatalUtf8(buffer) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
}

function findFrameEnd(buffer) {
  const crlf = buffer.indexOf(CRLF_SEP);
  const lf = buffer.indexOf(LF_SEP);
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
    return { index: crlf, separator: CRLF_SEP };
  }
  if (lf !== -1) return { index: lf, separator: LF_SEP };
  return undefined;
}

function eventFromSseBlock(block) {
  const dataLines = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (!dataLines.length) return undefined;
  const dataText = dataLines.join("\n");
  if (!dataText || dataText === "[DONE]") return undefined;
  try {
    return JSON.parse(dataText);
  } catch {
    return undefined;
  }
}

export function invalidCompletedFunctionCallTransform(
  namespaces,
  contentType = "",
  { tools } = {},
) {
  const type = String(contentType).toLowerCase();
  if (!type.includes("text/event-stream") && !type.includes("json")) return undefined;
  const lookups = namespaces ? buildNamespaceLookups(namespaces) : undefined;
  return new InvalidCompletedFunctionCallTransform(
    lookups,
    type.includes("text/event-stream"),
    tools,
  );
}

export class InvalidCompletedFunctionCallTransform extends Transform {
  #lookups;
  #tools;
  #eventStream;
  #buffer = Buffer.alloc(0);
  #passthrough = false;
  #namesByItemId = new Map();
  #heldCalls = new Map();

  constructor(lookups, eventStream = true, tools = undefined) {
    super();
    this.#lookups = lookups;
    this.#tools = tools;
    this.#eventStream = eventStream;
  }

  _transform(chunk, encoding, callback) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (this.#passthrough) {
      this.push(piece);
      callback();
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, piece]) : piece;
    try {
      if (this.#eventStream) this.#emitSse(false);
      else if (this.#buffer.length > MAX_JSON_CAPTURE_BYTES) this.#releaseJson();
    } catch (error) {
      callback(error);
      return;
    }
    callback();
  }

  _flush(callback) {
    try {
      if (!this.#passthrough) {
        if (this.#eventStream) {
          this.#emitSse(true);
          this.#flushAllHeld();
        } else this.#finishJson();
      }
    } catch (error) {
      callback(error);
      return;
    }
    callback();
  }

  #reject(invalid) {
    this.#heldCalls.clear();
    throw new InvalidFunctionCallArgumentsError({
      source: "response",
      ...invalid,
    });
  }

  #hold(itemId, original) {
    let held = this.#heldCalls.get(itemId);
    if (!held) {
      held = { frames: [], bytes: 0 };
      this.#heldCalls.set(itemId, held);
    }
    held.bytes += original.length;
    if (held.bytes > MAX_JSON_CAPTURE_BYTES) {
      this.#flushHeld(itemId);
      return false;
    }
    held.frames.push(original);
    return true;
  }

  #flushHeld(itemId) {
    const held = this.#heldCalls.get(itemId);
    if (!held) return;
    this.#heldCalls.delete(itemId);
    for (const frame of held.frames) this.push(frame);
  }

  #dropHeld(itemId) {
    this.#heldCalls.delete(itemId);
  }

  #flushAllHeld() {
    for (const itemId of [...this.#heldCalls.keys()]) this.#flushHeld(itemId);
  }

  #withKnownName(event) {
    if (!event || typeof event !== "object") return event;
    const itemId = typeof event.item_id === "string"
      ? event.item_id
      : typeof event.item?.id === "string"
        ? event.item.id
        : undefined;
    const known = itemId ? this.#namesByItemId.get(itemId) : undefined;
    if (!known) return event;
    let next = event;
    if (typeof event.name !== "string" || !event.name) {
      next = { ...next, name: known.name };
      if (known.namespace && next.namespace === undefined) {
        next = { ...next, namespace: known.namespace };
      }
    }
    if (event.item && (typeof event.item.name !== "string" || !event.item.name)) {
      next = {
        ...next,
        item: {
          ...event.item,
          name: known.name,
          ...(known.namespace && event.item.namespace === undefined
            ? { namespace: known.namespace }
            : {}),
        },
      };
    }
    return next;
  }

  #emitSse(flush) {
    while (this.#buffer.length && !this.#passthrough) {
      if (this.#buffer.length > MAX_SSE_FRAME_BYTES && !findFrameEnd(this.#buffer)) {
        this.#releaseJson();
        return;
      }
      const found = findFrameEnd(this.#buffer);
      if (!found) {
        if (!flush) return;
        const original = this.#buffer;
        this.#buffer = Buffer.alloc(0);
        this.#inspectSseFrame(original);
        return;
      }
      const original = this.#buffer.subarray(0, found.index + found.separator.length);
      this.#buffer = this.#buffer.subarray(found.index + found.separator.length);
      this.#inspectSseFrame(original);
    }
  }

  #inspectSseFrame(original) {
    if (original.length > MAX_SSE_FRAME_BYTES) {
      this.push(original);
      return;
    }
    let text;
    try {
      text = fatalUtf8(original);
    } catch {
      this.#passthrough = true;
      this.push(original);
      if (this.#buffer.length) this.push(this.#buffer);
      this.#buffer = Buffer.alloc(0);
      return;
    }
    let event = eventFromSseBlock(text);
    if (event?.type === "response.output_item.added" && event.item?.type === "function_call") {
      const itemId = typeof event.item.id === "string" ? event.item.id : undefined;
      if (itemId && typeof event.item.name === "string") {
        this.#namesByItemId.set(itemId, {
          name: event.item.name,
          namespace: typeof event.item.namespace === "string" ? event.item.namespace : undefined,
        });
      }
    }
    event = this.#withKnownName(event);
    const holdId = functionCallHoldId(event);
    if (holdId) {
      if (!this.#hold(holdId, original)) {
        this.push(original);
        return;
      }
      const invalid = findUnusableCompletedFunctionCall(event, { lookups: this.#lookups, tools: this.#tools });
      if (invalid) {
        this.#dropHeld(holdId);
        this.#reject(invalid);
      }
      if (isFunctionCallCompletion(event)) this.#flushHeld(holdId);
      return;
    }
    const invalid = findUnusableCompletedFunctionCall(event, { lookups: this.#lookups, tools: this.#tools });
    if (invalid) this.#reject(invalid);
    if (
      event?.type === "response.completed"
      || event?.type === "response.done"
    ) {
      this.#flushAllHeld();
    }
    this.push(original);
  }

  #releaseJson() {
    this.#flushAllHeld();
    if (this.#buffer.length) this.push(this.#buffer);
    this.#buffer = Buffer.alloc(0);
    this.#passthrough = true;
  }

  #finishJson() {
    if (!this.#buffer.length) return;
    if (this.#buffer.length > MAX_JSON_CAPTURE_BYTES) {
      this.#releaseJson();
      return;
    }
    let text;
    try {
      text = fatalUtf8(this.#buffer);
    } catch {
      this.#releaseJson();
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      this.#releaseJson();
      return;
    }
    const invalid = findUnusableCompletedFunctionCall(payload, { lookups: this.#lookups, tools: this.#tools });
    if (invalid) this.#reject(invalid);
    this.push(this.#buffer);
    this.#buffer = Buffer.alloc(0);
  }
}
