// SPDX-License-Identifier: MPL-2.0
// Only explicitly wrapped tick fields bypass JSON's floating-point numbers.
class TickInteger {
    constructor(decimal) {
        this.decimal = decimal;
        Object.freeze(this);
    }
}

export function tickInteger(value) {
    if (value === undefined)
        value = '0';
    if (typeof value === 'number' && Number.isSafeInteger(value))
        value = String(value);
    if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value))
        throw new Error('invalid_position');
    const negative = value[0] === '-';
    const digits = negative ? value.slice(1) : value;
    const maximum = negative ? '9223372036854775808' : '9223372036854775807';
    if (digits.length > maximum.length || (digits.length === maximum.length && digits > maximum))
        throw new Error('invalid_position');
    return new TickInteger(value);
}

// Request bodies are plain JSON DTOs. Ordinary leaves and keys still use the
// standard escaper; no string replacement can turn user text into JSON syntax.
export function wireJson(value) {
    const parents = new Set();
    function encode(current, key) {
        if (current instanceof TickInteger)
            return current.decimal;
        if (current && typeof current.toJSON === 'function')
            current = current.toJSON(key);
        if (!current || typeof current !== 'object')
            return JSON.stringify(current);
        if (parents.has(current))
            throw new TypeError('Converting circular structure to JSON');
        parents.add(current);
        let result;
        if (Array.isArray(current)) {
            const entries = [];
            for (let i = 0; i < current.length; ++i)
                entries.push(encode(current[i], String(i)) || 'null');
            result = '[' + entries.join(',') + ']';
        } else {
            const entries = [];
            for (const name of Object.keys(current)) {
                const encoded = encode(current[name], name);
                if (encoded !== undefined)
                    entries.push(JSON.stringify(name) + ':' + encoded);
            }
            result = '{' + entries.join(',') + '}';
        }
        parents.delete(current);
        return result;
    }
    return encode(value, '');
}
