"""
Launches all trading agents in separate threads on a single Railway service.
"""
import logging
import sys
import threading

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logging.getLogger("apscheduler.executors.default").setLevel(logging.WARNING)
logger = logging.getLogger("runner")


def _run(name: str, target) -> threading.Thread:
    def wrapper():
        try:
            logger.info(f"{name} starting")
            target()
        except Exception as exc:
            logger.exception(f"{name} crashed: {exc}")

    t = threading.Thread(target=wrapper, name=name, daemon=True)
    t.start()
    return t


if __name__ == "__main__":
    import config
    logger.info(f"DEMO_MODE={'ON — live trading disabled' if config.DEMO_MODE else 'OFF — live trading ENABLED'}")

    import ema_strategy_main as agent_ema
    import agent_trendline

    t1 = _run("ema-strategy-agent", agent_ema.main)
    t2 = _run("trendline-agent", agent_trendline.main)

    try:
        t1.join()
        t2.join()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Runner stopped")
