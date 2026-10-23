/**
 * Built-in Monaco snippets for the locked Lua API (tickets #4 + #9).
 *
 * Covers every surface the maintainer locked: `serial.open` / `tcp.open`
 * (+ listen/accept/send/recv/close for both), top-level `send_expect` /
 * `expect` with the three match `mode`s (`prefix` default, `regex`,
 * `pattern`), and the `log` / `hex` / `json` helpers. Rule reminders are
 * baked into snippet bodies: data is always a Lua string (raw bytes) and
 * timeouts are integer milliseconds.
 *
 * This module never imports `monaco-editor` at runtime (type-only import),
 * so it stays in the cheap initial chunk; Monaco itself lazy-loads in
 * `ScriptEditor`.
 */
import type * as monaco from "monaco-editor";

export interface LuaSnippet {
  /** Stable key, e.g. `serial.open`. */
  key: string;
  /** Completion label shown in the suggest widget. */
  label: string;
  /** One-line doc shown beside the label. */
  detail: string;
  /** Snippet body with `${1:…}` tab stops. */
  body: string;
}

export const LUA_SNIPPETS: LuaSnippet[] = [
  {
    key: "serial.open",
    label: "serial.open",
    detail: "Open a serial transport (data is a Lua string)",
    body: [
      'local ${1:h}, ${2:err} = serial.open("${3:/dev/ttyUSB0}", {',
      "\tbaudrate = ${4:115200},",
      "\ttimeout_ms = ${5:1000},",
      "})",
    ].join("\n"),
  },
  {
    key: "serial.send",
    label: "serial.send",
    detail: "Send raw bytes (Lua string) → err",
    body: "local ${1:err} = serial.send(${2:h}, ${3:bytes})",
  },
  {
    key: "serial.recv",
    label: "serial.recv",
    detail: "Receive raw bytes; nil + \"timeout\" on timeout",
    body: "local ${1:data}, ${2:err} = serial.recv(${3:h}, ${4:1000})",
  },
  {
    key: "serial.close",
    label: "serial.close",
    detail: "Explicit close (__gc is only a backup)",
    body: "serial.close(${1:h})",
  },
  {
    key: "tcp.open",
    label: "tcp.open",
    detail: "Open a TCP client transport",
    body: [
      'local ${1:c}, ${2:err} = tcp.open("${3:192.168.1.10}", ${4:502}, {',
      "\ttimeout_ms = ${5:1000},",
      "})",
    ].join("\n"),
  },
  {
    key: "tcp.listen",
    label: "tcp.listen",
    detail: "Listen for an inbound TCP connection",
    body: "local ${1:s}, ${2:err} = tcp.listen(${3:502}, {${4:}})",
  },
  {
    key: "tcp.accept",
    label: "tcp.accept",
    detail: "Accept one connection (timeout_ms)",
    body: "local ${1:conn}, ${2:err} = tcp.accept(${3:s}, ${4:1000})",
  },
  {
    key: "tcp.send",
    label: "tcp.send",
    detail: "Send raw bytes (Lua string) → err",
    body: "local ${1:err} = tcp.send(${2:c}, ${3:bytes})",
  },
  {
    key: "tcp.recv",
    label: "tcp.recv",
    detail: "Receive raw bytes; nil + \"timeout\" on timeout",
    body: "local ${1:data}, ${2:err} = tcp.recv(${3:c}, ${4:1000})",
  },
  {
    key: "tcp.close",
    label: "tcp.close",
    detail: "Explicit close (__gc is only a backup)",
    body: "tcp.close(${1:c})",
  },
  {
    key: "send_expect",
    label: "send_expect",
    detail: "Send then expect; backlog scanned before new frames",
    body: [
      "local ${1:data}, ${2:err} = send_expect(${3:h}, ${4:bytes}, ${5:pattern}, {",
      '\tmode = "${6:prefix}",',
      "\ttimeout_ms = ${7:1000},",
      "})",
    ].join("\n"),
  },
  {
    key: "expect",
    label: "expect",
    detail: "Expect a pattern (prefix default); first registered, first matched",
    body: [
      "local ${1:data}, ${2:err} = expect(${3:h}, ${4:pattern}, {",
      '\tmode = "${5:prefix}",',
      "\ttimeout_ms = ${6:1000},",
      "})",
    ].join("\n"),
  },
  {
    key: "expect.regex",
    label: "expect (regex mode)",
    detail: "Expect with mode = \"regex\"",
    body: [
      "local ${1:data}, ${2:err} = expect(${3:h}, ${4:pattern}, {",
      '\tmode = "regex",',
      "\ttimeout_ms = ${5:1000},",
      "})",
    ].join("\n"),
  },
  {
    key: "expect.pattern",
    label: "expect (pattern mode)",
    detail: "Expect with mode = \"pattern\" (Lua patterns)",
    body: [
      "local ${1:data}, ${2:err} = expect(${3:h}, ${4:pattern}, {",
      '\tmode = "pattern",',
      "\ttimeout_ms = ${5:1000},",
      "})",
    ].join("\n"),
  },
  {
    key: "log",
    label: "log",
    detail: "Script log helper → output pane",
    body: "log(${1:...})",
  },
  {
    key: "hex.encode",
    label: "hex.encode",
    detail: "Encode raw bytes to hex string",
    body: "local ${1:hex} = hex.encode(${2:data})",
  },
  {
    key: "hex.decode",
    label: "hex.decode",
    detail: "Decode hex string to raw bytes",
    body: "local ${1:data} = hex.decode(${2:hex})",
  },
  {
    key: "json.encode",
    label: "json.encode",
    detail: "Encode a table to a JSON string",
    body: "local ${1:s} = json.encode(${2:value})",
  },
  {
    key: "json.decode",
    label: "json.decode",
    detail: "Decode a JSON string to a table",
    body: "local ${1:value} = json.decode(${2:s})",
  },
];

/**
 * Register the built-in snippets as a Monaco Lua completion provider.
 * Returns the disposable so the editor owner can clean it up. Safe to call
 * once per Monaco instance (duplicate registration only duplicates
 * suggestions, so owners SHOULD guard with a module-level flag).
 */
export function registerLuaSnippets(
  monacoApi: typeof monaco,
): monaco.IDisposable {
  return monacoApi.languages.registerCompletionItemProvider("lua", {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: monaco.languages.CompletionItem[] = LUA_SNIPPETS.map(
        (s) => ({
          label: s.label,
          kind: monacoApi.languages.CompletionItemKind.Snippet,
          detail: s.detail,
          insertText: s.body,
          insertTextRules:
            monacoApi.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        }),
      );
      return { suggestions };
    },
  });
}
