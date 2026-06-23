#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const rootDir = new URL("../", import.meta.url);
const cliProgramPath = new URL("../packages/cli/src/program.ts", import.meta.url);
const cliReadmePath = new URL("../packages/cli/README.md", import.meta.url);
const mcpToolsDir = new URL("../packages/mcp/src/tools/", import.meta.url);
const mcpReadmePath = new URL("../packages/mcp/README.md", import.meta.url);

const checkOnly = process.argv.includes("--check");

function extractCliCommands() {
  const source = readFileSync(cliProgramPath, "utf8");
  const commands = [...source.matchAll(/\.command\("([^"]+)"\)/g)].map(
    (match) => match[1],
  );
  return [...new Set(commands)];
}

function extractMcpTools() {
  return readdirSync(mcpToolsDir)
    .filter(
      (name) =>
        name.endsWith(".ts") &&
        !name.endsWith(".test.ts") &&
        !name.endsWith(".integration.test.ts") &&
        name !== "index.ts",
    )
    .map((name) => name.replace(/\.ts$/, ""))
    .sort((a, b) => a.localeCompare(b));
}

function renderSingleColumnTable(header, values) {
  const lines = [`| ${header} |`, "|---|"];
  for (const value of values) {
    lines.push(`| \`${value}\` |`);
  }
  return lines.join("\n");
}

function replaceGeneratedSection(readmeText, sectionName, generatedMarkdown) {
  const startMarker = `<!-- GENERATED:${sectionName}_START -->`;
  const endMarker = `<!-- GENERATED:${sectionName}_END -->`;
  const pattern = new RegExp(
    `${startMarker}[\\s\\S]*?${endMarker}`,
    "m",
  );

  if (!pattern.test(readmeText)) {
    throw new Error(`Could not find generated section markers for ${sectionName}`);
  }

  return readmeText.replace(
    pattern,
    `${startMarker}\n${generatedMarkdown}\n${endMarker}`,
  );
}

function updateReadme(pathLike, sectionName, generatedMarkdown) {
  const original = readFileSync(pathLike, "utf8");
  const updated = replaceGeneratedSection(original, sectionName, generatedMarkdown);

  if (checkOnly) {
    if (updated !== original) {
      throw new Error(`Generated README content is out of date: ${pathLike.pathname}`);
    }
    return;
  }

  if (updated !== original) {
    writeFileSync(pathLike, updated, "utf8");
  }
}

const cliCommands = extractCliCommands();
const mcpTools = extractMcpTools();

updateReadme(
  cliReadmePath,
  "CLI_COMMANDS",
  [
    "The table below is generated from [`packages/cli/src/program.ts`](src/program.ts).",
    "",
    renderSingleColumnTable("Command", cliCommands),
  ].join("\n"),
);

updateReadme(
  mcpReadmePath,
  "MCP_TOOLS",
  [
    "The table below is generated from [`packages/mcp/src/tools/`](src/tools).",
    "",
    renderSingleColumnTable("Tool", mcpTools),
  ].join("\n"),
);

if (!checkOnly) {
  const relCli = join("packages", "cli", "README.md");
  const relMcp = join("packages", "mcp", "README.md");
  process.stdout.write(`Updated ${relCli} and ${relMcp}\n`);
}
