# Avvio delle shell dei terminali di AgiCloud: come una shell di login normale...
[ -f "$HOME/.profile" ] && . "$HOME/.profile"
[ -f "$HOME/.bashrc" ] && ! grep -q '\.bashrc' "$HOME/.profile" 2>/dev/null && . "$HOME/.bashrc"
# ...ma senza il token Claude di ~/.bashrc (serve al webhook-server): qui `claude`
# deve usare il login dell'account (~/.claude/.credentials.json), come la chat.
unset CLAUDE_CODE_OAUTH_TOKEN
