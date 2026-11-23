const wildcard = /[*?]/;
const evidenceSegment = /^[\p{L}\p{M}\p{N}_. @,()[\]'+=:!%&;*?-]+$/u;

export function isAuditEvidencePath(value) {
  return typeof value === 'string' && value.length <= 500
    && value.split('/').every(segment => segment !== '.' && segment !== '..' && evidenceSegment.test(segment));
}

export function readAuditFilePaths(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const paths = [...new Set(value)];
  return paths.every(isAuditEvidencePath) ? paths : null;
}

function validFileGlob(value) {
  return isAuditEvidencePath(value) && wildcard.test(value)
    && value.split('/').every(segment => segment === '**' || !segment.includes('**'));
}

export function readAuditFileGlobs(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const globs = [...new Set(value)];
  return globs.length === value.length && globs.every(validFileGlob) ? globs : null;
}

function matchesTokens(pattern, input, wildcardToken, matches) {
  let nextToken = 0, nextInput = 0, lastWildcard = -1, wildcardEnd = 0;
  while (nextInput < input.length) {
    const token = pattern[nextToken];
    if (token === wildcardToken) {
      lastWildcard = nextToken++;
      wildcardEnd = nextInput;
    } else if (token !== undefined && matches(token, input[nextInput])) {
      nextToken++;
      nextInput++;
    } else if (lastWildcard >= 0) {
      nextToken = lastWildcard + 1;
      nextInput = ++wildcardEnd;
    } else return false;
  }
  return pattern.slice(nextToken).every(token => token === wildcardToken);
}

export function matchAuditFileGlobs(globs) {
  const patterns = globs.map(glob => glob.split('/').map(segment => segment === '**' ? '**' : [...segment]));
  const matchesSegment = (pattern, name) => matchesTokens(pattern, name, '*', (token, char) => token === '?' || token === char);
  return path => {
    const segments = path.split('/').map(segment => [...segment]);
    return patterns.some(pattern => matchesTokens(pattern, segments, '**', matchesSegment));
  };
}
