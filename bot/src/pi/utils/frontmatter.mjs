// Derived from earendil-works/pi v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0).
// Copyright (c) 2025 Mario Zechner. MIT; see third_party/pi/LICENSE and SOURCES.json.
import { parse } from "yaml";
import { stripBom } from "./text.mjs";
const normalizeNewlines = (value)=>value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const extractFrontmatter = (content)=>{
    const normalized = normalizeNewlines(stripBom(content));
    if (!normalized.startsWith("---")) {
        return {
            yamlString: null,
            body: normalized
        };
    }
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
        return {
            yamlString: null,
            body: normalized
        };
    }
    return {
        yamlString: normalized.slice(4, endIndex),
        body: normalized.slice(endIndex + 4).trim()
    };
};
export const parseFrontmatter = (content)=>{
    const { yamlString, body } = extractFrontmatter(content);
    if (!yamlString) {
        return {
            frontmatter: {},
            body
        };
    }
    const parsed = parse(yamlString);
    return {
        frontmatter: parsed ?? {},
        body
    };
};
export const stripFrontmatter = (content)=>parseFrontmatter(content).body;
