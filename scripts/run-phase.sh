#!/usr/bin/env bash
#
# run-phase.sh
#
# Orchestrates Claude Code sessions for DankDash development.
# Runs one phase, rests 5 minutes, schedules next phase in 10 minutes.
#
# Usage:
#   ./run-phase.sh 0          # Run phase 0 only
#   ./run-phase.sh 0 22       # Run phases 0 through 22 with pacing
#   ./run-phase.sh --resume   # Resume from last completed phase (reads PROGRESS.md)
#
# Requirements:
#   - claude CLI installed and authenticated (https://docs.claude.com)
#   - You're in the DankDash repo root
#   - PROGRESS.md exists (created in phase 0)
#
# This script doesn't actually invoke Claude Code's autonomy loop —
# it sets up the prompt files and timer so you, the operator, can paste
# the prompt into Claude Code and walk away. Between phases, the script
# handles the pacing and prepares the next prompt.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PROMPTS_FILE="${REPO_ROOT}/docs/CLAUDE-CODE-PROMPTS.md"
readonly PHASES_FILE="${REPO_ROOT}/docs/CLAUDE-CODE-PHASES.md"
readonly PROGRESS_FILE="${REPO_ROOT}/PROGRESS.md"
readonly SESSION_LOG="${REPO_ROOT}/.dankdash-session.log"

readonly REST_SECONDS=$((5 * 60))      # 5 minutes between phases
readonly WAKE_DELAY_SECONDS=$((10 * 60)) # 10 minutes before next phase

readonly PHASE_NAMES=(
  "Foundation & Tooling"
  "Database & Migrations"
  "Auth & Identity"
  "Compliance Engine"
  "Dispensaries & Catalog"
  "Cart & Checkout"
  "Payments (Aeropay)"
  "Order Lifecycle & State Machine"
  "Dispatch & Driver Foundation"
  "Realtime Service (Socket.io)"
  "Tracking & Geofencing"
  "Metrc Traceability"
  "Notifications"
  "Vendor Portal: Auth & Shell"
  "Vendor Portal: Live Order Queue"
  "Vendor Portal: Menu & Analytics"
  "iOS Consumer: Foundation"
  "iOS Consumer: Feed & Catalog"
  "iOS Consumer: Cart, Checkout, Tracking"
  "iOS Driver: Foundation & Shift"
  "iOS Driver: Offers, Navigation, ID Scan"
  "Hardening: Security, Observability, Load Test"
  "Pre-launch: Admin Console, Runbooks, Docs"
)

readonly TOTAL_PHASES=${#PHASE_NAMES[@]}

# ---------- helpers ----------

log() {
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  echo "[${timestamp}] $*" | tee -a "${SESSION_LOG}"
}

banner() {
  echo ""
  echo "════════════════════════════════════════════════════════════════"
  echo "  $*"
  echo "════════════════════════════════════════════════════════════════"
  echo ""
}

require_repo_root() {
  if [[ ! -f "${PHASES_FILE}" ]]; then
    echo "Error: Run this script from a directory where docs/CLAUDE-CODE-PHASES.md exists."
    echo "Current directory: ${REPO_ROOT}"
    exit 1
  fi
}

last_completed_phase() {
  if [[ ! -f "${PROGRESS_FILE}" ]]; then
    echo "-1"
    return
  fi
  grep -oE "^## Phase [0-9]+" "${PROGRESS_FILE}" 2>/dev/null \
    | awk '{print $3}' \
    | sort -n \
    | tail -1 \
    || echo "-1"
}

countdown() {
  local seconds=$1
  local label=$2
  local end_ts=$(( $(date +%s) + seconds ))
  while [[ $(date +%s) -lt ${end_ts} ]]; do
    local remaining=$(( end_ts - $(date +%s) ))
    local mins=$(( remaining / 60 ))
    local secs=$(( remaining % 60 ))
    printf "\r  %s — %02d:%02d remaining   " "${label}" "${mins}" "${secs}"
    sleep 1
  done
  printf "\r%-70s\r" " "
}

prepare_phase_prompt() {
  local phase_num=$1
  local phase_name="${PHASE_NAMES[$phase_num]}"
  local prompt_file="${REPO_ROOT}/.next-prompt.md"

  cat > "${prompt_file}" <<EOF
# Claude Code Session — Phase ${phase_num}: ${phase_name}

You are working on DankDash, a three-sided cannabis delivery platform for the Minnesota adult-use market. You are acting as a principal engineer at a top-tier engineering organization — think Stripe, Linear, Vercel, Anthropic.

The complete development plan is in \`docs/CLAUDE-CODE-PHASES.md\` at the repository root. Read it now, top to bottom, before doing anything else. Specifically, internalize the "NON-NEGOTIABLE RULES" section at the top — every rule there applies to every line of code you write in this session.

The architecture, database schema, API surface, and compliance engine reference implementation live in \`docs/spec/\`. Treat these as the source of truth.

YOU ARE THE ENGINEER. The user is the founder/PM. They expect:
- Code that would pass a senior code review at a top-tier company
- No placeholder TODOs left behind
- No \`any\` types
- Tests written and passing in the same session as the code
- All green-light commands (typecheck, lint, test, build) passing before you call the phase done
- One branch per phase, conventional commits, PR opened at end

If you find yourself thinking "I'll just stub this and come back" — STOP. Implement it properly or write to BLOCKED.md. There is no "come back."

If you find yourself thinking "this test is hard to write, let me skip it" — STOP. The test is hard because the design is wrong. Fix the design.

If you find yourself thinking "this passes locally, ship it" — STOP. Run the green-light commands. Actually run them. Read the output.

The codebase regulates a regulated industry. Cannabis license violations can shut the business down. You write code accordingly.

---

## This Session: Phase ${phase_num} — ${phase_name}

Read \`docs/CLAUDE-CODE-PHASES.md\` section "PHASE ${phase_num}" carefully. Also re-read \`PROGRESS.md\` to see what was accomplished in prior phases. Match the patterns already established in the codebase.

Work through every task listed for this phase, in order. Do not skip tasks. Do not stop short of the Definition of Done.

Before writing code:
1. Re-read the relevant section of the spec docs in \`docs/spec/\`
2. Survey the existing codebase for patterns to match
3. Identify the test cases you'll write (write tests FIRST when possible)
4. Sketch the module structure

Then execute.

When complete:
1. Run green-light commands and paste the output:
   \`\`\`
   pnpm install
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm --filter @dankdash/api build
   \`\`\`
2. Commit any final changes (conventional commits, scoped)
3. Push the branch \`phase/$(printf "%02d" ${phase_num})-$(echo "${phase_name}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')\`
4. Open a PR
5. Update \`PROGRESS.md\` with a one-paragraph summary
6. Stop and tell me what was accomplished

This is the work of building something that lasts. Take your time. Do it right.
EOF

  log "Prepared prompt for Phase ${phase_num} at ${prompt_file}"
  echo ""
  echo "Phase ${phase_num} prompt ready: ${prompt_file}"
  echo ""
  echo "→ Open Claude Code"
  echo "→ Paste the contents of .next-prompt.md"
  echo "→ Let it work"
  echo ""
}

post_phase_verify() {
  local phase_num=$1
  banner "Post-Phase ${phase_num} Verification"

  cd "${REPO_ROOT}"

  log "git status:"
  git status

  echo ""
  log "Last 5 commits:"
  git log --oneline -5

  echo ""
  log "Running green-light commands..."

  if ! pnpm typecheck; then
    log "❌ pnpm typecheck FAILED. Phase ${phase_num} is NOT complete."
    return 1
  fi
  if ! pnpm lint; then
    log "❌ pnpm lint FAILED. Phase ${phase_num} is NOT complete."
    return 1
  fi
  if ! pnpm test; then
    log "❌ pnpm test FAILED. Phase ${phase_num} is NOT complete."
    return 1
  fi

  log "✅ Phase ${phase_num} verified clean."
  return 0
}

rest_and_schedule() {
  local next_phase=$1
  local next_phase_name="${PHASE_NAMES[$next_phase]}"

  banner "5-Minute Rest — Phase ${next_phase} (${next_phase_name}) up next"
  log "Resting until $(date -d "+${REST_SECONDS} seconds" '+%H:%M:%S' 2>/dev/null \
                       || date -v +"${REST_SECONDS}S" '+%H:%M:%S' 2>/dev/null \
                       || echo "after rest")"

  countdown "${REST_SECONDS}" "Rest"

  banner "10-Minute Wake Window — Phase ${next_phase} (${next_phase_name})"
  log "Wake window opens at $(date '+%H:%M:%S'). Phase will be ready in ${WAKE_DELAY_SECONDS}s."
  log "Use this time to spot-check the previous phase's PR before continuing."

  countdown "${WAKE_DELAY_SECONDS}" "Wake delay"

  log "Wake time. Preparing Phase ${next_phase}..."
  prepare_phase_prompt "${next_phase}"
}

# ---------- main ----------

require_repo_root

case "${1:-}" in
  --resume)
    last_done=$(last_completed_phase)
    if [[ "${last_done}" == "-1" ]]; then
      echo "No prior phase found in PROGRESS.md. Starting from Phase 0."
      START=0
    else
      START=$(( last_done + 1 ))
      log "Resuming from Phase ${START} (last completed: ${last_done})"
    fi
    END=$(( TOTAL_PHASES - 1 ))
    ;;
  "")
    echo "Usage:"
    echo "  $0 <start_phase> [end_phase]"
    echo "  $0 --resume"
    echo ""
    echo "Examples:"
    echo "  $0 0           # Run phase 0 only"
    echo "  $0 0 5         # Run phases 0-5 with 5min rest + 10min wake between"
    echo "  $0 --resume    # Continue from last completed phase"
    exit 1
    ;;
  *)
    START=$1
    END=${2:-$1}
    ;;
esac

if (( START < 0 || START >= TOTAL_PHASES )); then
  echo "Error: Phase ${START} out of range (0-$(( TOTAL_PHASES - 1 )))"
  exit 1
fi

banner "DankDash Development — Phases ${START} to ${END}"
log "Repository: ${REPO_ROOT}"
log "Total phases: ${TOTAL_PHASES}"

for (( phase=START; phase<=END; phase++ )); do
  banner "Phase ${phase} — ${PHASE_NAMES[$phase]}"

  prepare_phase_prompt "${phase}"

  echo ""
  echo "→ Paste the prompt into Claude Code now."
  echo "→ When Claude Code reports the phase is complete, press ENTER to continue."
  read -r -p "[Press ENTER when Phase ${phase} is done] "

  if ! post_phase_verify "${phase}"; then
    echo ""
    echo "Phase ${phase} verification FAILED. Fix the issues, then press ENTER to retry verification, or Ctrl-C to abort."
    read -r
    if ! post_phase_verify "${phase}"; then
      log "Phase ${phase} STILL failing. Aborting orchestration."
      exit 1
    fi
  fi

  if (( phase < END )); then
    rest_and_schedule $(( phase + 1 ))
  fi
done

banner "🎉 All requested phases complete (${START} → ${END})"
log "Session log saved to ${SESSION_LOG}"
