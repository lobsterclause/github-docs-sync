import type { SensitiveMatch } from "./types.js";

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "AWS Access Key", regex: /AKIA[0-9A-Z]{16}/g },
  {
    name: "GCP Service Account",
    regex: /"type"\s*:\s*"service_account"/g,
  },
  {
    name: "API Key Assignment",
    regex:
      /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/gi,
  },
  {
    name: "Generic Secret",
    regex: /(?:password|passwd|token|credential)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
  },
  {
    name: "Private Key Block",
    regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
  },
];

// Patterns that are always false positives in documentation
const FALSE_POSITIVE_PATTERNS = [
  /example\.com/i,
  /\$\{.*\}/, // template variables
  /your[_-]?api[_-]?key/i,
  /<your[_-]/i,
  /REPLACE_ME/i,
  /placeholder/i,
  /sk-test/i, // Stripe test keys are safe
];

/**
 * Scans content for potential sensitive data.
 */
export function scanForSensitiveContent(
  content: string,
  _filePath: string,
): SensitiveMatch[] {
  const lines = content.split("\n");
  const matches: SensitiveMatch[] = [];

  for (const { name, regex } of PATTERNS) {
    // Reset regex state
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const matchText = match[0];

      // Skip false positives
      if (FALSE_POSITIVE_PATTERNS.some((fp) => fp.test(matchText))) continue;

      // Find line number
      const beforeMatch = content.slice(0, match.index);
      const line = beforeMatch.split("\n").length;

      // Skip matches inside code fences that are clearly examples
      const lineText = lines[line - 1] || "";
      if (lineText.includes("example") || lineText.includes("Example"))
        continue;

      matches.push({ pattern: name, match: matchText, line });
    }
  }

  return matches;
}

/**
 * Returns true if the file contains high-confidence secrets that should block sync.
 */
export function shouldSkipFile(matches: SensitiveMatch[]): boolean {
  return matches.some(
    (m) =>
      m.pattern === "AWS Access Key" ||
      m.pattern === "GCP Service Account" ||
      m.pattern === "Private Key Block",
  );
}
