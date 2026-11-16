// Decides which requests are forwarded, from the user's settings (see config.js).

/** @typedef {import('../config.js').Settings} Settings */

/**
 * @param {Pick<Settings, 'ignoredTypes' | 'includeUrls' | 'excludeUrls' | 'methods'>} settings
 * @returns {(request: { url: string, method?: string }, resourceType: string | undefined) => boolean}
 */
export function createFilter({ ignoredTypes, includeUrls, excludeUrls, methods }) {
    const ignored = new Set(ignoredTypes);
    const include = compilePatterns(includeUrls);
    const exclude = compilePatterns(excludeUrls);
    const allowedMethods = parseMethods(methods);

    return (request, resourceType) => {
        const { url, method } = request;
        return (
            /^https?:/i.test(url) &&
            !(resourceType !== undefined && ignored.has(resourceType)) &&
            (allowedMethods.size === 0 || allowedMethods.has(method?.toUpperCase() ?? '')) &&
            (include.length === 0 || include.some((re) => re.test(url))) &&
            !exclude.some((re) => re.test(url))
        );
    };
}

/**
 * One pattern per line; blank lines and lines starting with # are ignored.
 * @param {string} text
 * @returns {RegExp[]}
 */
export function compilePatterns(text) {
    return String(text)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((pattern) => {
            const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            const source = pattern.includes('*') ? `^${escaped.replaceAll('*', '.*')}$` : escaped;
            return new RegExp(source, 'i');
        });
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseMethods(text) {
    return new Set(
        String(text)
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((m) => m.toUpperCase()),
    );
}
