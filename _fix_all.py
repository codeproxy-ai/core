import os, re

d = '/Users/mushan/Documents/project/codeproxy-core/tests'

for fname in sorted(os.listdir(d)):
    if not fname.endswith('.test.ts'):
        continue
    fp = os.path.join(d, fname)
    with open(fp, 'r') as f:
        orig = f.read()
    c = orig
    
    # === 1. FIX: one-letter variable names ===
    
    # `c` in stream ReadableStream start(c) -> start(controller)
    c = re.sub(r'start\(c\)\s*\{', 'start(controller) {', c)
    c = re.sub(r'\bstart\(c\)\s*{', 'start(controller) {', c)
    # c.enqueue -> controller.enqueue
    c = re.sub(r'(?<!const |let |var |_\s*)\bc\.enqueue\b', 'controller.enqueue', c)
    c = re.sub(r'(?<!const |let |var |_\s*)\bc\.close\b', 'controller.close', c)
    
    # `e` in events.filter((e) or events.find((e) -> event (only if e used in body)
    # These are lambda parameters, we need to be careful
    c = re.sub(r'events\.filter\(\(e\)\s*=>\s*\{', 'events.filter((event) => {', c)
    c = re.sub(r'events\.filter\(\(e\)\s*=>\s*[a-z]', 'events.filter((event) => event', c)
    c = re.sub(r'events\.find\(\(e\)\s*=>\s*\{', 'events.find((event) => {', c)
    c = re.sub(r'events\.find\(\(e\)\s*=>\s*[a-z]', 'events.find((event) => event', c)
    c = re.sub(r'events\.filter\(\(e\)\s*=>\s*\(', 'events.filter((event) => (', c)
    c = re.sub(r'events\.find\(\(e\)\s*=>\s*\(', 'events.find((event) => (', c)
    
    # `e` in .find((e) or .filter((e) in general
    c = re.sub(r'\.find\(\(e\)\s*=>\s*\{', '.find((event) => {', c)
    c = re.sub(r'\.filter\(\(e\)\s*=>\s*\{', '.filter((event) => {', c)
    
    # `m` in messages.find((m) or messages.filter((m) -> msg
    c = re.sub(r'messages\.find\(\(m\)\s*=>', 'messages.find((msg) =>', c)
    c = re.sub(r'messages\.filter\(\(m\)\s*=>', 'messages.filter((msg) =>', c)
    c = re.sub(r'messages\.map\(\(m\)\s*=>', 'messages.map((msg) =>', c)
    
    # `m` in single-var param of .find or .filter
    c = re.sub(r'\.find\(\(m\)\s*=>\s*\{', '.find((msg) => {', c)
    c = re.sub(r'\.filter\(\(m\)\s*=>\s*\{', '.filter((msg) => {', c)
    c = re.sub(r'\.some\(\(m\)\s*=>\s*\{', '.some((msg) => {', c)
    c = re.sub(r'\.some\(\(m\)\s*=>\s*[a-z]', '.some((msg) => msg', c)
    c = re.sub(r'\.find\(\(m\)\s*=>\s*[a-z]', '.find((msg) => msg', c)
    c = re.sub(r'\.filter\(\(m\)\s*=>\s*[a-z]', '.filter((msg) => msg', c)
    
    # `m` in .find((m) => m.type || m.something
    c = re.sub(r'\.find\(\(m\)\s*=>\s*m\.', '.find((msg) => msg.', c)
    c = re.sub(r'\.filter\(\(m\)\s*=>\s*m\.', '.filter((msg) => msg.', c)
    
    # `m` in .forEach((m) => ...)
    c = re.sub(r'\.forEach\(\(m\)\s*=>', '.forEach((msg) =>', c)
    
    # `b` in content.some((b: ...) or similar
    c = re.sub(r'\(b:\s*\{', '(block: {', c)
    c = re.sub(r'\.some\(\(b\)\s*=>', '.some((block) =>', c)
    c = re.sub(r'\bb\.type\b', 'block.type', c)
    c = re.sub(r'\bb\.text\b', 'block.text', c)
    
    # `r` variable (let r = or const r =)
    # Be careful: only fix `r` as a destructured or single variable
    # Check if it's a map variable
    
    # `a` and `b` in utils.test.ts
    c = re.sub(r'const a = ', 'const valueA = ', c)
    c = re.sub(r'const b = ', 'const valueB = ', c)
    
    # `p` variable
    c = re.sub(r'\(p:\s*\{', '(param: {', c)
    c = re.sub(r'\.forEach\(\(p\)', '.forEach((param)', c)
    c = re.sub(r'\.forEach\(\(p,\s*', '.forEach((param, ', c)
    
    # === 2. FIX: unused variables - add _ prefix ===
    # Unused 'input' in fetch handlers
    c = re.sub(r'(async\s*\()(input)([,\s])', r'\1_input\3', c)
    c = re.sub(r'async\s+\(\s*input\s*\)\s*=>', 'async (_input) =>', c)
    c = re.sub(r'async\s+\(\s*input\s*,\s*init\s*\)\s*=>', 'async (_input, _init) =>', c)
    
    # === 3. FIX: as never[] -> remove ===
    c = c.replace('] as never[]);', ']);')
    c = c.replace(' as never[];', ';')
    c = c.replace(' as never,', ',')
    c = c.replace(' as never\n', '\n')
    
    # === 4. Detect and fix known as assertion patterns that shouldn't use as never ===
    # Replace `as never` with proper code
    c = c.replace('null as never', 'null')
    c = c.replace('undefined as never', 'undefined')
    
    # === 5. Fix 'msg' in anthropic-request-edge-cases-3.test.ts (find msg already fixed)
    # Fix anthropic-request-edge-cases-2.test.ts - 'm' -> 'msg'
    
    # === 6. Remove unused imports ===
    # Remove import of unnamed, empty imports
    c = re.sub(r'import \{\s*\}\s+from', '', c)
    # Remove lines with empty import
    lines = c.split('\n')
    new_lines = [l for l in lines if not l.strip().startswith('import { }')]
    c = '\n'.join(new_lines)
    
    # === 7. Fix specific unused imports ===
    # TranslateResponse unused in edge-cases.test.ts
    if fname == 'edge-cases.test.ts':
        c = c.replace("import { anthropicTranslateStream, translateResponse, encodeSseEvent }", "import { anthropicTranslateStream }")
        c = c.replace("import { translateResponse, encodeSseEvent } from", "import { /* empty */ } from")
        c = c.replace("import { translateResponse, encodeSseEvent } from", "")
    
    if fname == 'final-coverage-targets.test.ts':
        # Need to remove unused named imports
        lines = c.split('\n')
        new_lines = []
        for l in lines:
            l2 = l
            # import { createResponsesFetch, anthropicTranslateResponse, translateAnthropicEvents, openaiTranslateStream, AnthropicStreamEvent }
            l2 = re.sub(r'\bcreateResponsesFetch,\s*', '', l2)
            l2 = re.sub(r'\banthropicTranslateResponse,\s*', '', l2)
            l2 = re.sub(r'\btranslateAnthropicEvents,\s*', '', l2)
            l2 = re.sub(r'\bopenaiTranslateStream,\s*', '', l2)
            l2 = re.sub(r'\bAnthropicStreamEvent,\s*', '', l2)
            l2 = re.sub(r'\bAnthropicStreamEvent\s*}', '}', l2)
            # Clean up empty imports
            l2 = re.sub(r'import \{\s*\}\s+from', '', l2)
            new_lines.append(l2)
        new_lines2 = [l for l in new_lines if not l.strip().startswith('import { }')]
        c = '\n'.join(new_lines2)
    
    if fname == 'all-remaining-branches.test.ts':
        lines = c.split('\n')
        new_lines = []
        for l in lines:
            l2 = l
            l2 = re.sub(r'\banthropicTranslateRequest,\s*', '', l2)
            l2 = re.sub(r'\bmapOutputItems,\s*', '', l2)
            l2 = re.sub(r'\bopenaiTranslateResponse,\s*', '', l2)
            l2 = re.sub(r'\bopenaiTranslateResponse\s*}', '}', l2)
            l2 = re.sub(r'\bencodeSseEvent,\s*', '', l2)
            l2 = re.sub(r'\bencodeSseEvent\s*}', '}', l2)
            l2 = re.sub(r'import \{\s*\}\s+from', '', l2)
            if not l2.strip().startswith('import { }'):
                new_lines.append(l2)
        c = '\n'.join(new_lines)
    
    if fname == 'fetch-edge-cases.test.ts':
        c = c.replace("import { parseSseStream, encodeSseEvent }", "import { parseSseStream }")
    
    if fname == 'openai-edge-cases.test.ts':
        c = c.replace("import { parseSseStream, encodeSseEvent }", "import { parseSseStream }")
    
    if fname == 'cache-logging.test.ts':
        c = c.replace("import { checkCache, cacheGet, cacheSet, LOG_PREFIX }", "import { checkCache, cacheGet, cacheSet, LOG_PREFIX }")
        # Only fix if there's actually an issue
    
    # === 8. Fix specific as assertion issues in known files ===
    # The remaining `as` assertions need precise line-level fixes
    # We'll handle these by reading the specific problematic patterns
    
    # Remove empty import lines
    lines = c.split('\n')
    new_lines = [l for l in lines if l.strip()]
    c = '\n'.join(new_lines)
    
    # Re-add blank lines around describe/it blocks
    # (This is a bit aggressive - let's not do this)
    
    if c != orig:
        with open(fp, 'w') as f:
            f.write(c)
        print(f"  Fixed: {fname}")
    else:
        print(f"  No changes: {fname}")

print("\n=== Phase 1 complete ===")
