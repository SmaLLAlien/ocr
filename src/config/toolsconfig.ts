// Tool (function-calling) definitions. Port of internal/config/toolsconfig.
import fs from 'node:fs';
import { readAsset } from '../util/assets.js';
import { stripBom } from '../util/text.js';
import type { FunctionDef, ToolDef } from '../llm/types.js';

/** A single tool definition loaded from tools.json. The definition field is
 * a flat FunctionDef ({name, description, parameters}); BuildToolDefs wraps
 * it into the {type:"function", function} shape. */
export interface ToolConfigEntry {
  name: string;
  plan_task: boolean;
  main_task: boolean;
  definition: FunctionDef;
}

/**
 * Parses the tools config file. When path is empty, falls back to the
 * bundled default tools configuration.
 */
export function loadToolsConfig(path: string): ToolConfigEntry[] {
  let data: string;
  if (path === '') {
    data = readAsset('tools.json');
  } else {
    try {
      data = fs.readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`read tools file ${path}: ${(err as Error).message}`);
    }
  }
  try {
    return JSON.parse(stripBom(data)) as ToolConfigEntry[];
  } catch (err) {
    throw new Error(`unmarshal tools file: ${(err as Error).message}`);
  }
}

/**
 * Converts config entries into tool definitions filtered by phase.
 * planOnly=true returns tools with plan_task:true; false → main_task:true.
 * Port of agent.BuildToolDefs.
 */
export function buildToolDefs(entries: ToolConfigEntry[], planOnly: boolean): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const t of entries) {
    if ((planOnly && t.plan_task) || (!planOnly && t.main_task)) {
      defs.push({ type: 'function', function: t.definition });
    }
  }
  return defs;
}
