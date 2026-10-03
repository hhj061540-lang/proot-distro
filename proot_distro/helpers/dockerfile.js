/**
 * # # Proot-Distro - manage proot containers.
 * # # Created by Sylirre <sylirre@termux.dev> for Termux project.
 * # # Ported to Node.js / JavaScript.
 */

import json from 'json5'; // or standard JSON, standard json built-in is fine since Dockerfile exec form is valid JSON

const INSTRUCTIONS = new Set([
    "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM", 
    "HEALTHCHECK", "LABEL", "MAINTAINER", "ONBUILD", "RUN", "SHELL", 
    "STOPSIGNAL", "USER", "VOLUME", "WORKDIR"
]);

const HEREDOC_INSTRUCTIONS = new Set(["ADD", "COPY", "RUN"]);
const DIRECTIVES = new Set(["syntax", "escape", "check"]);

export const MAX_DOCKERFILE_BYTES = 16 * 1024 * 1024;

export class DockerfileSyntaxError extends Error {
    constructor(message) {
        super(message);
        this.name = "DockerfileSyntaxError";
    }
}

export function parseDockerfile(text) {
    if (Buffer.isBuffer(text)) {
        text = text.toString("utf8");
    } else if (typeof text !== "string") {
        text = String(text);
    }

    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (text.charCodeAt(0) === 0xFEFF) {
        text = text.slice(1);
    }

    const rawLines = text.split("\n");
    const { directives, directiveEnd } = parseDirectives(rawLines);
    
    let escapeChar = directives.get("escape") || "\\";
    if (escapeChar !== "\\" && escapeChar !== "`") {
        escapeChar = "\\";
        directives.delete("escape");
    } else {
        directives.delete("escape");
    }

    const instructions = parseInstructions(rawLines, directiveEnd, escapeChar);
    return { directives, instructions };
}

const DIRECTIVE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/;

function parseDirectives(rawLines) {
    const directives = new Map();
    let idx = 0;
    const n = rawLines.length;

    while (idx < n) {
        const line = rawLines[idx];
        const stripped = line.trim();
        if (!stripped) {
            idx++;
            continue;
        }
        if (!stripped.startsWith("#")) {
            break;
        }
        const inner = stripped.slice(1);
        const m = inner.match(DIRECTIVE_RE);
        if (!m) break;

        const key = m[1].toLowerCase();
        if (!DIRECTIVES.has(key)) break;
        if (directives.has(key)) break;

        directives.set(key, m[2].trim());
        idx++;
    }

    return { directives, directiveEnd: idx };
}

const FLAG_RE = /^--([A-Za-z][A-Za-z0-9_-]*)(?:=(\S*))?(?=\s|$)/;
const HEREDOC_RE = /<<(-?)(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/;

function parseInstructions(rawLines, startIdx, escapeChar) {
    const instructions = [];
    const n = rawLines.length;
    let i = startIdx;

    while (i < n) {
        const rawLine = rawLines[i];
        const lineNo = i + 1;
        const stripped = rawLine.trimLeft ? rawLine.trimLeft() : rawLine.replace(/^\s+/, "");
        
        if (!stripped) {
            i++;
            continue;
        }
        if (stripped.startsWith("#")) {
            i++;
            continue;
        }

        const accumulatedParts = [rawLine];
        let cur = rawLine;

        while (endsWidthEscape(cur, escapeChar)) {
            accumulatedParts[accumulatedParts.length - 1] = stripTrailingEscape(
                accumulatedParts[accumulatedParts.length - 1],
                escapeChar
            );
            i++;
            while (i < n) {
                const nxt = rawLines[i];
                const nxtLstripped = nxt.trimLeft ? nxt.trimLeft() : nxt.replace(/^\s+/, "");
                if (!nxtLstripped) {
                    i++;
                    continue;
                }
                if (nxtLstripped.startsWith("#")) {
                    i++;
                    continue;
                }
                break;
            }
            if (i >= n) {
                cur = "";
                break;
            }
            cur = rawLines[i];
            accumulatedParts.push(cur);
        }

        const accumulated = accumulatedParts.map(p => p.trim()).join(" ").trim();
        if (!accumulated) {
            i++;
            continue;
        }

        const m = accumulated.match(/^\s*(\S+)\s*(.*)$/);
        if (!m) {
            i++;
            continue;
        }

        let name = m[1].toUpperCase();
        let rest = m[2];

        if (!INSTRUCTIONS.has(name)) {
            throw new DockerfileSyntaxError(`Unknown instruction '${name}' at line ${lineNo}.`);
        }

        const isOnbuild = (name === "ONBUILD");
        let outerName = null;

        if (isOnbuild) {
            const innerMatch = rest.match(/^\s*(\S+)\s*(.*)$/);
            if (!innerMatch) {
                throw new DockerfileSyntaxError(`ONBUILD without inner instruction at line ${lineNo}.`);
            }
            const innerName = innerMatch[1].toUpperCase();
            if (!INSTRUCTIONS.has(innerName) || innerName === "ONBUILD") {
                throw new DockerfileSyntaxError(`Invalid ONBUILD inner instruction '${innerName}' at line ${lineNo}.`);
            }
            outerName = name;
            name = innerName;
            rest = innerMatch[2];
        }

        const { flags, rest: parsedRest } = parseFlags(rest);
        let value = parsedRest.trim();
        const heredocs = [];

        if (HEREDOC_INSTRUCTIONS.has(name)) {
            const hereTags = extractHeredocTags(value);
            for (const { stripIndent, tag } of hereTags) {
                const { body, nextIndex } = collectHeredocBody(rawLines, i + 1, tag, stripIndent);
                heredocs.push({ tag, strip_indent: stripIndent, body });
                i = nextIndex - 1; // adjust loop index
            }
            if (hereTags.length === 0) {
                i++;
            } else {
                i++;
            }
        } else {
            i++;
        }

        const { isExec, parsedValue } = tryExecForm(value);
        const record = {
            name,
            flags,
            value: isExec ? parsedValue : value,
            exec_form: isExec,
            heredocs,
            lineno: lineNo,
            raw: accumulated,
        };

        if (isOnbuild) {
            instructions.push({
                name: "ONBUILD",
                flags: {},
                value: record,
                exec_form: false,
                heredocs: [],
                lineno: lineNo,
                raw: accumulated,
            });
        } else {
            instructions.push(record);
        }
    }

    return instructions;
}

function endsWidthEscape(line, escapeChar) {
    const s = line.trimRight ? line.trimRight() : line.replace(/\s+$/, "");
    if (!s || !s.endsWith(escapeChar)) return false;

    let cnt = 0;
    let j = s.length - 1;
    while (j >= 0 && s[j] === escapeChar) {
        cnt++;
        j--;
    }
    return (cnt % 2) === 1;
}

function stripTrailingEscape(line, escapeChar) {
    let s = line.trimRight ? line.trimRight() : line.replace(/\s+$/, "");
    if (s.endsWith(escapeChar)) {
        s = s.slice(0, -1);
    }
    return s.trimRight ? s.trimRight() : s.replace(/\s+$/, "");
}

function parseFlags(text) {
    const flags = {};
    while (true) {
        const m = text.match(FLAG_RE);
        if (!m) break;

        const key = m[1];
        let val = m[2] !== undefined ? m[2] : "";

        if (m[0].includes("=")) {
            const afterEq = m[0].split("=")[1];
            if (afterEq && (afterEq[0] === '"' || afterEq[0] === "'")) {
                try {
                    const restAfter = text.slice(m.index + m[0].indexOf("=") + 1);
                    // simple token extraction fallback
                    val = restAfter.match(/^"([^"]*)"|^'([^']*)'/) || [restAfter.split(/\s+/)[0]];
                    val = Array.isArray(val) ? (val[1] || val[2] || val[0]) : val;
                } catch (e) {}
            }
        }
        flags[key] = val;
        text = text.slice(m[0].length).trimLeft ? text.slice(m[0].length).trimLeft() : text.slice(m.index + m[0].length);
    }
    return { flags, rest: text };
}

function extractHeredocTags(value) {
    const tags = [];
    let match;
    const regex = new RegExp(HEREDOC_RE.source, 'g');
    while ((match = regex.exec(value)) !== null) {
        tags.push({
            stripIndent: match[1] === "-",
            tag: match[3]
        });
    }
    return tags;
}

function collectHeredocBody(rawLines, startI, tag, stripIndent) {
    const body = [];
    let i = startI;
    const n = rawLines.length;

    while (i < n) {
        const line = rawLines[i];
        const cmpLine = stripIndent ? line.replace(/^\t+/, "") : line;
        if (cmpLine === tag || cmpLine.trim() === tag) {
            return {
                body: body.join("\n") + (body.length > 0 ? "\n" : ""),
                nextIndex: i + 1
            };
        }
        body.push(stripIndent ? line.replace(/^\t+/, "") : line);
        i++;
    }

    throw new DockerfileSyntaxError(`Unterminated here-doc body for tag '${tag}'.`);
}

function tryExecForm(value) {
    const s = value.trim();
    if (!s.startsWith("[") || !s.endsWith("]")) {
        return { isExec: false, parsedValue: null };
    }
    try {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed) || !parsed.every(x => typeof x === "string")) {
            return { isExec: false, parsedValue: null };
        }
        return { isExec: true, parsedValue: parsed };
    } catch (e) {
        return { isExec: false, parsedValue: null };
    }
}

export function expandVars(text, env) {
    let out = [];
    let i = 0;
    const n = text.length;

    while (i < n) {
        const c = text[i];
        if (c === "\\" && i + 1 < n) {
            out.push(text[i + 1]);
            i += 2;
            continue;
        }
        if (c !== "$") {
            out.push(c);
            i++;
            continue;
        }

        if (i + 1 < n && text[i + 1] === "{") {
            const close = text.indexOf("}", i + 2);
            if (close < 0) {
                throw new DockerfileSyntaxError("Unterminated ${...} expression in value.");
            }
            const inner = text.slice(i + 2, close);
            i = close + 1;
            out.push(expandBraced(inner, env));
        } else {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_]/.test(text[j])) {
                j++;
            }
            if (j === i + 1) {
                out.push("$");
                i++;
            } else {
                const name = text.slice(i + 1, j);
                out.push(lookupOrEmpty(name, env));
                i = j;
            }
        }
    }
    return out.join("");
}

const BRACED_OP_RE = /^([A-Za-z_][A-Za-z0-9_]*)(:[-+?]|[-+?])(.*)$/;

function expandBraced(inner, env) {
    const m = inner.match(BRACED_OP_RE);
    if (!m) {
        return lookupOrEmpty(inner, env);
    }
    const name = m[1];
    const op = m[2];
    const arg = m[3];
    const raw = env[name];

    if (op === ":-") return !raw ? arg : raw;
    if (op === "-") return raw === undefined ? arg : raw;
    if (op === ":+") return raw ? arg : "";
    if (op === "+") return raw !== undefined ? arg : "";

    return lookupOrEmpty(name, env);
}

function lookupOrEmpty(name, env) {
    const val = env[name];
    return val === undefined || val === null ? "" : String(val);
}
