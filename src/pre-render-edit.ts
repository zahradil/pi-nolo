/**
 * Pre-render edit diffs — shows a diff preview while the edit tool is executing.
 * Ported from pi-pre-render-edit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDiff, createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, Container, type Component } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import * as os from "node:os";

// ── Types ──────────────────────────────────────────────────────────────────

interface Edit {
  oldText: string;
  newText: string;
}

interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

interface EditDiffError {
  error: string;
}

export type PreviewState = {
  argsKey?: string;
  preview?: EditDiffResult | EditDiffError;
};

// ── Path helpers ───────────────────────────────────────────────────────────

function resolveToCwd(path: string, cwd: string): string {
  const cleaned = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

function shortenPath(path: string): string {
  const home = os.homedir();
  if (path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

// ── Diff computation ───────────────────────────────────────────────────────

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function stripBom(content: string): { bom: string; text: string } {
  if (content.charCodeAt(0) === 0xfeff) {
    return { bom: content[0], text: content.slice(1) };
  }
  return { bom: "", text: content };
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
  }
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true, contentForReplacement: fuzzyContent };
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function applyEditsToContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): { baseContent: string; newContent: string } {
  const normalizedEdits = edits.map((e) => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw new Error(
        normalizedEdits.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`,
      );
    }
  }

  const initialMatches = normalizedEdits.map((e) => fuzzyFindText(normalizedContent, e.oldText));
  const baseContent = initialMatches.some((m) => m.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: { editIndex: number; matchIndex: number; matchLength: number; newText: string }[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const match = fuzzyFindText(baseContent, edit.oldText);
    if (!match.found) {
      const label = normalizedEdits.length === 1 ? "oldText" : `edits[${i}].oldText`;
      throw new Error(`Could not find ${label} in ${path}. The text must match exactly.`);
    }
    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      const label = normalizedEdits.length === 1 ? "text" : `edits[${i}].oldText`;
      throw new Error(`Found ${occurrences} occurrences of ${label} in ${path}. Provide more context to make it unique.`);
    }
    matchedEdits.push({ editIndex: i, matchIndex: match.index, matchLength: match.matchLength, newText: edit.newText });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const prev = matchedEdits[i - 1];
    const curr = matchedEdits[i];
    if (prev.matchIndex + prev.matchLength > curr.matchIndex) {
      throw new Error(`edits[${prev.editIndex}] and edits[${curr.editIndex}] overlap in ${path}. Merge them into one edit.`);
    }
  }

  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const e = matchedEdits[i];
    newContent = newContent.substring(0, e.matchIndex) + e.newText + newContent.substring(e.matchIndex + e.matchLength);
  }

  if (baseContent === newContent) {
    throw new Error(`No changes produced in ${path}. The replacement is identical to the original.`);
  }

  return { baseContent, newContent };
}

function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];
  const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      if (lastWasChange && nextIsChange) {
        if (raw.length <= contextLines * 2) {
          for (const line of raw) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        } else {
          for (const line of raw.slice(0, contextLines)) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          const skipped = raw.length - contextLines * 2;
          oldLineNum += skipped;
          newLineNum += skipped;
          for (const line of raw.slice(raw.length - contextLines)) {
            output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
            oldLineNum++;
            newLineNum++;
          }
        }
      } else if (lastWasChange) {
        const shown = raw.slice(0, contextLines);
        for (const line of shown) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
        if (raw.length > contextLines) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += raw.length - contextLines;
          newLineNum += raw.length - contextLines;
        }
      } else if (nextIsChange) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        for (const line of raw.slice(skipped)) {
          output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
          newLineNum++;
        }
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

async function computeEditsDiff(
  path: string,
  edits: Edit[],
  cwd: string,
): Promise<EditDiffResult | EditDiffError> {
  const absolutePath = resolveToCwd(path, cwd);
  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch {
      return { error: `File not found: ${path}` };
    }
    const rawContent = await readFile(absolutePath, "utf-8");
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);
    const { baseContent, newContent } = applyEditsToContent(normalizedContent, edits, path);
    return generateDiffString(baseContent, newContent);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Input normalization ────────────────────────────────────────────────────

function getPreviewEdits(
  args: { path?: string; oldText?: string; newText?: string; edits?: Edit[] } | undefined,
): { path: string; edits: Edit[] } | null {
  if (!args || typeof args.path !== "string") return null;

  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e: any) => typeof e?.oldText === "string" && typeof e?.newText === "string")
  ) {
    return { path: args.path, edits: args.edits };
  }

  if (typeof args.oldText === "string" && typeof args.newText === "string" && args.edits === undefined) {
    return { path: args.path, edits: [{ oldText: args.oldText, newText: args.newText }] };
  }

  return null;
}

// ── Register the edit tool with pre-rendered diffs ─────────────────────────

export function registerPreRenderEdit(pi: ExtensionAPI, cwd: string) {
  const builtIn = createEditToolDefinition(cwd);

  pi.registerTool({
    ...builtIn,

    renderCall(args: any, theme: any, context: any) {
      const state = context.state as PreviewState;

      if (context.argsComplete) {
        const previewInput = getPreviewEdits(args);
        if (previewInput) {
          const argsKey = JSON.stringify({ path: previewInput.path, edits: previewInput.edits });
          if (state.argsKey !== argsKey) {
            state.argsKey = argsKey;
            computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
              if (state.argsKey === argsKey) {
                state.preview = preview;
                context.invalidate();
              }
            });
          }
        }
      }

      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

      const rawPath = str(args?.file_path ?? args?.path);
      const path = rawPath !== null ? shortenPath(rawPath) : null;
      const pathDisplay =
        path === null
          ? theme.fg("error", "???")
          : path
            ? theme.fg("accent", path)
            : theme.fg("toolOutput", "...");

      let content = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

      if (state.preview) {
        if ("error" in state.preview) {
          content += `\n\n${theme.fg("error", state.preview.error)}`;
        } else if (state.preview.diff) {
          content += `\n\n${renderDiff(state.preview.diff, { filePath: rawPath ?? undefined })}`;
        }
      }

      text.setText(content);
      return text;
    },

    renderResult(result: any, _options: any, theme: any, context: any) {
      const state = context.state as PreviewState;
      const args = context.args;
      const rawPath = str(args?.file_path ?? args?.path);

      if (context.isError) {
        const errorText = result.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n");

        let previewError: string | undefined;
        if (state.preview && "error" in state.preview) {
          previewError = state.preview.error;
        }
        if (!errorText || errorText === previewError) {
          const component = (context.lastComponent as Container | undefined) ?? new Container();
          component.clear();
          return component;
        }
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(`\n${theme.fg("error", errorText)}`);
        return text;
      }

      const resultDiff = result.details?.diff;
      const previewDiff = state.preview && !("error" in state.preview) ? state.preview.diff : undefined;
      if (!resultDiff || resultDiff === previewDiff) {
        const component = (context.lastComponent as Container | undefined) ?? new Container();
        component.clear();
        return component;
      }

      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(`\n${renderDiff(resultDiff, { filePath: rawPath ?? undefined })}`);
      return text;
    },
  });
}
