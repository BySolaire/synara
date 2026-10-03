import { describe, expect, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  UNASSIGNED_KEYBINDING_KEY,
} from "@synara/contracts";

import { resolveDesktopMenuShortcuts } from "./useDesktopMenuShortcuts";

const MAC = "MacIntel";
const terminalFocus: KeybindingWhenNode = { type: "identifier", name: "terminalFocus" };
const notTerminalFocus: KeybindingWhenNode = { type: "not", node: terminalFocus };

function mod(key: string, overrides: Partial<KeybindingShortcut> = {}): KeybindingShortcut {
  return {
    key,
    modKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function rule(
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst?: KeybindingWhenNode,
): ResolvedKeybindingRule {
  return whenAst ? { command, shortcut, whenAst } : { command, shortcut };
}

const DEFAULT_MENU_RULES = [
  rule("sidebar.toggle", mod("b"), notTerminalFocus),
  rule("terminal.new", mod("t"), terminalFocus),
  rule("browser.toggle", mod("b", { shiftKey: true }), notTerminalFocus),
];

describe("resolveDesktopMenuShortcuts", () => {
  it("reports the default chords, resolving terminal.new where a terminal is focused", () => {
    expect(resolveDesktopMenuShortcuts(DEFAULT_MENU_RULES, MAC)).toEqual({
      "terminal.new": mod("t"),
      "sidebar.toggle": mod("b"),
      "browser.toggle": mod("b", { shiftKey: true }),
    });
  });

  it("follows a rebinding", () => {
    const keybindings = [...DEFAULT_MENU_RULES, rule("sidebar.toggle", mod("j"), notTerminalFocus)];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["sidebar.toggle"]).toEqual(mod("j"));
  });

  it("reports null for an unassigned command instead of restoring its default", () => {
    const keybindings = [
      rule("sidebar.toggle", mod(UNASSIGNED_KEYBINDING_KEY, { modKey: false })),
      rule("terminal.new", mod("t"), terminalFocus),
      rule("browser.toggle", mod("b", { shiftKey: true }), notTerminalFocus),
    ];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["sidebar.toggle"]).toBeNull();
  });

  it("reports null when a later rule takes the command's chord", () => {
    const keybindings = [...DEFAULT_MENU_RULES, rule("chat.new", mod("b"), notTerminalFocus)];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["sidebar.toggle"]).toBeNull();
  });

  it("copies only the shortcut fields the bridge accepts", () => {
    const keybindings = [
      rule("browser.toggle", { ...mod("o"), extra: true } as KeybindingShortcut, notTerminalFocus),
    ];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["browser.toggle"]).toEqual(mod("o"));
  });
});
