from pathlib import Path

p = Path('.github/scripts/temp_events_patch.py')
s = p.read_text()
start = s.index('provider_old = ')
end = s.index('p.write_text(s)', start)
replacement = '''needle = "      return { success: false, error: 'RATE_LIMIT' };"
idx = s.rfind(needle)
assert idx != -1
s = s[:idx] + "      return { success: false, error: 'RATE_LIMIT', rateLimitSource: 'provider' };" + s[idx + len(needle):]
'''
p.write_text(s[:start] + replacement + s[end:])
