#!/bin/bash
# Trigger the create-evidence-file workflow via claude -p
# Usage: ./scripts/create-evidence-file.sh <keyword>

if [ -z "$1" ]; then
  echo "Usage: $0 <keyword>"
  exit 1
fi

claude \
  --allowedTools "mcp__plugin_atlassian_atlassian__*" \
  --allowedTools "Bash" \
  --allowedTools "Read" \
  --allowedTools "Write" \
  -p "Follow the instructions in .claude/commands/create-evidence-file.md with keyword '$1'"
