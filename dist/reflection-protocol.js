export const REFLECTION_ROOT_TAG = "reflection";
export const MAX_REFLECTION_TEXT_CHARACTERS = 16_384;
export const MAX_REFLECTION_TOOL_CALLS = 10;
/** Maximum total invalid XML attempts, matching the continue-watchdog contract. */
export const MAX_REFLECTION_REASKS = 3;
function decodeXmlEntities(value) {
    let result = "";
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char !== "&") {
            result += char;
            continue;
        }
        const semicolon = value.indexOf(";", index + 1);
        if (semicolon === -1)
            return null;
        const entity = value.slice(index + 1, semicolon);
        if (entity === "lt")
            result += "<";
        else if (entity === "gt")
            result += ">";
        else if (entity === "amp")
            result += "&";
        else if (entity === "quot")
            result += '"';
        else if (entity === "apos")
            result += "'";
        else if (/^#\d+$/.test(entity)) {
            const codePoint = Number(entity.slice(1));
            if (!Number.isSafeInteger(codePoint) ||
                codePoint < 0 ||
                codePoint > 0x10ffff ||
                (codePoint >= 0xd800 && codePoint <= 0xdfff))
                return null;
            result += String.fromCodePoint(codePoint);
        }
        else if (/^#x[0-9a-fA-F]+$/.test(entity)) {
            const codePoint = Number.parseInt(entity.slice(2), 16);
            if (!Number.isSafeInteger(codePoint) ||
                codePoint < 0 ||
                codePoint > 0x10ffff ||
                (codePoint >= 0xd800 && codePoint <= 0xdfff))
                return null;
            result += String.fromCodePoint(codePoint);
        }
        else
            return null;
        index = semicolon;
    }
    return result;
}
function skipWhitespace(source, index) {
    while (/\s/u.test(source[index] ?? ""))
        index += 1;
    return index;
}
function readName(source, index) {
    const match = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(index));
    return match === null
        ? null
        : { name: match[0], next: index + match[0].length };
}
/** Extract one unique bare trailing reflection XML document, case-insensitively. */
export function extractTrailingReflectionXml(text) {
    if (Array.from(text).length > MAX_REFLECTION_TEXT_CHARACTERS)
        return null;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();
    const open = `<${REFLECTION_ROOT_TAG}>`;
    const close = `</${REFLECTION_ROOT_TAG}>`;
    if (!lower.endsWith(close))
        return null;
    const start = lower.lastIndexOf(open);
    if (start === -1 || lower.indexOf(open) !== start)
        return null;
    const closeIndex = lower.indexOf(close);
    if (closeIndex !== lower.lastIndexOf(close))
        return null;
    return trimmed.slice(start);
}
/** Parse required case-insensitive tags while rejecting duplicate required fields. */
export function parseReflectionXml(text) {
    const document = extractTrailingReflectionXml(text);
    if (document === null)
        return { valid: false, error: "End with one valid reflection XML block." };
    const lower = document.toLowerCase();
    const rootOpen = `<${REFLECTION_ROOT_TAG}>`;
    const rootClose = `</${REFLECTION_ROOT_TAG}>`;
    if (!lower.startsWith(rootOpen))
        return { valid: false, error: "The reflection root must be a bare tag." };
    let index = rootOpen.length;
    const required = new Set([
        "type",
        "reason",
        "done",
        "current_step",
        "next_step",
    ]);
    const fields = new Map();
    while (true) {
        index = skipWhitespace(document, index);
        if (lower.startsWith(rootClose, index)) {
            index += rootClose.length;
            if (index !== document.length)
                return { valid: false, error: "Unsupported trailing XML content." };
            break;
        }
        if (document[index] !== "<" || "/!?".includes(document[index + 1] ?? ""))
            return { valid: false, error: "Malformed reflection XML." };
        index += 1;
        const openName = readName(document, index);
        if (openName === null || document[openName.next] !== ">")
            return {
                valid: false,
                error: "Reflection fields cannot have attributes.",
            };
        const normalizedName = openName.name.toLowerCase();
        index = openName.next + 1;
        const textStart = index;
        while (index < document.length && document[index] !== "<")
            index += 1;
        const decoded = decodeXmlEntities(document.slice(textStart, index));
        if (decoded === null ||
            document[index] !== "<" ||
            document[index + 1] !== "/")
            return { valid: false, error: "Malformed reflection field content." };
        const closeName = readName(document, index + 2);
        if (closeName === null ||
            closeName.name.toLowerCase() !== normalizedName ||
            document[closeName.next] !== ">")
            return { valid: false, error: "Reflection field tags do not match." };
        index = closeName.next + 1;
        if (!required.has(normalizedName))
            continue;
        if (fields.has(normalizedName))
            return {
                valid: false,
                error: `Duplicate reflection field: ${normalizedName}.`,
            };
        const value = decoded.trim();
        if (value.length === 0)
            return {
                valid: false,
                error: `Reflection field ${normalizedName} must be non-empty.`,
            };
        fields.set(normalizedName, value);
    }
    for (const name of required) {
        if (!fields.has(name))
            return {
                valid: false,
                error: `Missing required reflection field: ${name}.`,
            };
    }
    const normalizedType = fields.get("type")?.toUpperCase();
    if (normalizedType !== "NO_ISSUE" && normalizedType !== "ROUTE_CORRECTION")
        return {
            valid: false,
            error: "Reflection type must be NO_ISSUE or ROUTE_CORRECTION.",
        };
    const reason = fields.get("reason");
    const done = fields.get("done");
    const currentStep = fields.get("current_step");
    const nextStep = fields.get("next_step");
    if (reason === undefined ||
        done === undefined ||
        currentStep === undefined ||
        nextStep === undefined)
        return { valid: false, error: "Missing required reflection field." };
    return {
        valid: true,
        decision: { type: normalizedType, reason, done, currentStep, nextStep },
    };
}
function escapeXml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
/** Append all non-customizable facts and parser constraints to the semantic prefix. */
export function buildReflectionPrompt(context) {
    const supplement = context.userSupplement?.trim();
    const previous = context.previousReflection;
    return `${context.semanticPrefix.trim()}\n\n[Plugin-generated reflection context]\nCurrent local RFC3339 time: ${context.timestamp}\nTrigger source(s): ${context.reasons.join(", ")}\nThreshold snapshot: root=${context.thresholds.rootLoops}/${context.thresholds.rootLoopLimit}; domain=${context.thresholds.domainLoops}/${context.thresholds.domainLoopLimit}; continuous-domain-active=${context.thresholds.continuousDomainActiveMs}ms/${context.thresholds.continuousDomainActiveMinutes}m\nUser supplement: ${supplement ? supplement : "(none)"}\nPrevious completed reflection: ${previous ? `${previous.timestamp}\n${previous.report}` : "(none)"}\n\nYou may use tools only when needed to verify the current route. This reflection and all XML correction attempts share one budget of ${MAX_REFLECTION_TOOL_CALLS} tool calls. The plugin blocks call ${MAX_REFLECTION_TOOL_CALLS + 1} before execution.\n\nEnd the response with exactly one <reflection>...</reflection> XML block. Tag names and the type value are case-insensitive. All five fields are required, unique, and non-empty. Total non-thinking assistant text must not exceed ${MAX_REFLECTION_TEXT_CHARACTERS} Unicode characters. Use one of:\n<reflection><type>NO_ISSUE</type><reason>why the route is sound</reason><done>completed work</done><current_step>current work</current_step><next_step>correct next step</next_step></reflection>\n<reflection><type>ROUTE_CORRECTION</type><reason>why the route must change</reason><done>completed work</done><current_step>current work</current_step><next_step>corrected next step</next_step></reflection>\n\nDo not copy untrusted text into XML without escaping it. Example escaped supplement: ${escapeXml(supplement ?? "none")}`;
}
export function buildReflectionReaskPrompt(error) {
    return `Your previous reflection response was invalid: ${error}\nCorrect it now. The same tool-call budget remains in force. End with one valid trailing reflection XML block containing unique non-empty type, reason, done, current_step, and next_step fields.`;
}
