// Derived from earendil-works/pi v1.3.0 (71023aec1546d6d677a65669c5665c0927ce0dd0).
// Copyright (c) 2025 Mario Zechner. MIT; see third_party/pi/LICENSE and SOURCES.json.
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages.mjs";
export function getLatestCompactionEntry(entries) {
    for(let i = entries.length - 1; i >= 0; i--){
        if (entries[i].type === "compaction") {
            return entries[i];
        }
    }
    return null;
}
function buildEntryIndex(entries, byId) {
    if (byId) return byId;
    const index = new Map();
    for (const entry of entries){
        index.set(entry.id, entry);
    }
    return index;
}
function buildSessionPath(entries, leafId, byId) {
    const index = buildEntryIndex(entries, byId);
    let leaf;
    if (leafId === null) {
        return [];
    }
    if (leafId) {
        leaf = index.get(leafId);
    }
    leaf ??= entries[entries.length - 1];
    if (!leaf) {
        return [];
    }
    const path = [];
    let current = leaf;
    while(current){
        path.push(current);
        current = current.parentId ? index.get(current.parentId) : undefined;
    }
    path.reverse();
    return path;
}
function getSessionContextSettings(path) {
    let thinkingLevel = "off";
    let model = null;
    for (const entry of path){
        if (entry.type === "thinking_level_change") {
            thinkingLevel = entry.thinkingLevel;
        } else if (entry.type === "model_change") {
            model = {
                provider: entry.provider,
                modelId: entry.modelId
            };
        } else if (entry.type === "message" && entry.message.role === "assistant") {
            model = {
                provider: entry.message.provider,
                modelId: entry.message.model
            };
        }
    }
    return {
        thinkingLevel,
        model
    };
}
export function sessionEntryToContextMessages(entry) {
    if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "system" && message.content == null) return [
            {
                ...message,
                content: ""
            }
        ];
        if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") && message.content == null) {
            return [
                {
                    ...message,
                    content: []
                }
            ];
        }
        return [
            message
        ];
    }
    if (entry.type === "custom_message") {
        return [
            createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp)
        ];
    }
    if (entry.type === "branch_summary" && entry.summary) {
        return [
            createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)
        ];
    }
    if (entry.type === "compaction") {
        const summary = createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
        return entry.systemMessage ? [
            entry.systemMessage,
            summary
        ] : [
            summary
        ];
    }
    return [];
}
export function buildContextEntries(entries, leafId, byId) {
    const path = buildSessionPath(entries, leafId, byId);
    let compaction = null;
    for (const entry of path){
        if (entry.type === "compaction") {
            compaction = entry;
        }
    }
    if (!compaction) {
        return path;
    }
    const compactionIdx = path.findIndex((entry)=>entry.id === compaction.id);
    if (compactionIdx < 0) {
        return path;
    }
    const contextEntries = [
        compaction
    ];
    let foundFirstKept = false;
    for(let i = 0; i < compactionIdx; i++){
        const entry = path[i];
        if (entry.id === compaction.firstKeptEntryId) {
            foundFirstKept = true;
        }
        if (foundFirstKept && !(entry.type === "message" && entry.message.role === "system")) {
            contextEntries.push(entry);
        }
    }
    contextEntries.push(...path.slice(compactionIdx + 1));
    return contextEntries;
}
function projectContextEntry(entry, edit) {
    const messages = sessionEntryToContextMessages(entry);
    if (!edit) return messages;
    const replacement = edit.replacement;
    if (replacement === null) return [];
    return messages.map((message)=>{
        if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult" && message.role !== "custom") {
            return message;
        }
        const content = (message.role === "assistant" || message.role === "toolResult") && typeof replacement.content === "string" ? [
            {
                type: "text",
                text: replacement.content
            }
        ] : replacement.content;
        return {
            ...message,
            content
        };
    });
}
export function buildSessionProjection(entries, leafId, byId) {
    const path = buildSessionPath(entries, leafId, byId);
    const { thinkingLevel, model } = getSessionContextSettings(path);
    const contextEntries = buildContextEntries(entries, leafId, byId);
    const edits = new Map();
    for (const entry of contextEntries){
        if (entry.type === "context_edit") edits.set(entry.targetId, entry);
    }
    const projectedEntries = contextEntries.map((sourceEntry, index)=>({
            sourceEntry,
            messages: sourceEntry.type === "compaction" && index > 0 ? [] : projectContextEntry(sourceEntry, edits.get(sourceEntry.id))
        }));
    return {
        entries: projectedEntries,
        messages: projectedEntries.flatMap((entry)=>entry.messages),
        thinkingLevel,
        model
    };
}
export function buildSessionContext(entries, leafId, byId) {
    const { messages, thinkingLevel, model } = buildSessionProjection(entries, leafId, byId);
    return {
        messages,
        thinkingLevel,
        model
    };
}
