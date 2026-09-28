"""Initialize app-owned OpenHands settings through its native store API."""
import os
import sys
from pathlib import Path
if os.environ.get("MCCA_ACP_DEBUG") == "1":
    import faulthandler
    faulthandler.dump_traceback_later(40)

from openhands_cli.stores import AgentStore
from openhands_cli.entrypoint import main
import openhands.sdk.skills.skill as skill_module

# The CLI unconditionally refreshes its public skill Git repository while
# validating every stored agent. Session creation must not wait on a network
# fetch. Reuse its existing cache; skill installation remains explicit.
def cached_skills_repository(repo_url, branch, cache_dir):
    directory = Path(cache_dir) / "public-skills"
    return directory if directory.is_dir() else None

skill_module.update_skills_repository = cached_skills_repository

if not os.environ.get("OPENHANDS_PERSISTENCE_DIR"):
    raise RuntimeError("An application-owned settings directory is required")
store = AgentStore()
agent = store.load_or_create(env_overrides_enabled=True)
if agent is None:
    raise RuntimeError("Configure an OpenHands model in the application first")
store.save(agent)
sys.argv = ["openhands", "acp", "--override-with-envs"]
main()
