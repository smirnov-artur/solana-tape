#!/usr/bin/env python3
"""Collect public, read-only Solana network statistics.

Every value written by this script carries the endpoint it came from and the
instant it was captured. Nothing is estimated silently: when a source fails or
does not exist, the metric is written with `value: null` and a stated reason,
and the page renders an honest gap instead of a number.

Standard library only. No API keys. No wallet, no signing, no transactions --
every RPC method used here is a read method.

    python scripts/collect.py            # collect and write data/
    python scripts/collect.py --dry-run  # collect and print, write nothing
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
HISTORY = os.path.join(DATA, "history")
USER_AGENT = "solana-tape/1.0 (+https://github.com/smirnov-artur/solana-tape)"

LAMPORTS = 1_000_000_000
SLOT_TARGET_MS = 400  # Solana's design target, used only for the "vs target" reading


# ----------------------------------------------------------------- plumbing


def load_config() -> dict:
    with open(os.path.join(ROOT, "config.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Fetcher:
    """HTTP with retries, gzip and a per-source log of what actually happened."""

    def __init__(self, cfg: dict):
        self.timeout = cfg["request_timeout_seconds"]
        self.retries = cfg["retries"]
        self.log: list[dict] = []

    def _open(self, req: urllib.request.Request) -> bytes:
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
            return raw

    def get(self, url: str, headers: dict | None = None):
        h = {"User-Agent": USER_AGENT, "Accept": "application/json", "Accept-Encoding": "gzip"}
        h.update(headers or {})
        last = ""
        for attempt in range(self.retries):
            started = time.time()
            try:
                raw = self._open(urllib.request.Request(url, headers=h))
                self.log.append({"url": url, "ok": True, "ms": int((time.time() - started) * 1000),
                                 "bytes": len(raw)})
                return json.loads(raw), None
            except Exception as exc:  # noqa: BLE001 - the reason is data, not a crash
                last = f"{type(exc).__name__}: {exc}"
                time.sleep(1.5 * (attempt + 1))
        self.log.append({"url": url, "ok": False, "error": last})
        return None, last

    def rpc(self, endpoints: list[str], method: str, params=None):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                           "params": params if params is not None else []}).encode()
        headers = {"User-Agent": USER_AGENT, "Content-Type": "application/json",
                   "Accept-Encoding": "gzip"}
        last = ""
        for endpoint in endpoints:
            for attempt in range(self.retries):
                started = time.time()
                try:
                    raw = self._open(urllib.request.Request(endpoint, data=body, headers=headers))
                    payload = json.loads(raw)
                    if "error" in payload:
                        last = f"rpc error {payload['error'].get('code')}: {payload['error'].get('message')}"
                        raise RuntimeError(last)
                    self.log.append({"url": f"{endpoint} :: {method}", "ok": True,
                                     "ms": int((time.time() - started) * 1000), "bytes": len(raw)})
                    return payload.get("result"), None
                except Exception as exc:  # noqa: BLE001
                    last = f"{type(exc).__name__}: {exc}"
                    time.sleep(1.0 * (attempt + 1))
            self.log.append({"url": f"{endpoint} :: {method}", "ok": False, "error": last})
        return None, last


class Sheet:
    """Accumulates metrics, each one bound to its source."""

    def __init__(self):
        self.metrics: dict[str, dict] = {}
        self.gaps: list[dict] = []

    def put(self, key: str, value, *, unit: str, label: str, group: str,
            source: str, endpoint: str, captured_at: str, note: str | None = None,
            error: str | None = None, precision: int | None = None):
        if isinstance(value, float):
            if not math.isfinite(value):
                value, error = None, error or "computed value is not finite"
            elif precision is not None:
                value = round(value, precision)
        self.metrics[key] = {
            "value": value, "unit": unit, "label": label, "group": group,
            "source": source, "endpoint": endpoint, "captured_at": captured_at,
            "note": note, "error": error,
        }

    def miss(self, key: str, *, unit: str, label: str, group: str, source: str,
             endpoint: str, reason: str):
        self.put(key, None, unit=unit, label=label, group=group, source=source,
                 endpoint=endpoint, captured_at=now_iso(), error=reason)

    def gap(self, metric: str, reason: str, tried: list[str]):
        self.gaps.append({"metric": metric, "reason": reason, "tried": tried})


def num(x):
    return x if isinstance(x, (int, float)) and math.isfinite(x) else None


# ----------------------------------------------------------------- sources


def collect_rpc(fetch: Fetcher, cfg: dict, sheet: Sheet) -> dict:
    """Network performance, validators, supply. Read-only JSON-RPC."""
    eps = cfg["rpc_endpoints"]
    primary = eps[0]
    raw: dict = {}

    health, err = fetch.rpc(eps, "getHealth")
    stamp = now_iso()
    sheet.put("health", health if health else None, unit="state", label="Node health",
              group="network", source="Solana JSON-RPC", endpoint=f"{primary} getHealth",
              captured_at=stamp, error=err)

    epoch, err = fetch.rpc(eps, "getEpochInfo")
    stamp = now_iso()
    if epoch:
        raw["epoch_info"] = epoch
        progress = epoch["slotIndex"] / epoch["slotsInEpoch"] * 100
        for key, value, unit, label, prec in (
            ("slot", epoch["absoluteSlot"], "slot", "Absolute slot", None),
            ("block_height", epoch["blockHeight"], "block", "Block height", None),
            ("epoch", epoch["epoch"], "epoch", "Epoch", None),
            ("epoch_progress", progress, "%", "Epoch complete", 3),
            ("epoch_slot_index", epoch["slotIndex"], "slot", "Slot in epoch", None),
            ("epoch_slots", epoch["slotsInEpoch"], "slot", "Slots per epoch", None),
            ("tx_count_total", epoch.get("transactionCount"), "tx", "Transactions, all time", None),
        ):
            sheet.put(key, value, unit=unit, label=label, group="network",
                      source="Solana JSON-RPC", endpoint=f"{primary} getEpochInfo",
                      captured_at=stamp, precision=prec)
    else:
        for key, label in (("slot", "Absolute slot"), ("block_height", "Block height"),
                           ("epoch", "Epoch"), ("epoch_progress", "Epoch complete"),
                           ("tx_count_total", "Transactions, all time")):
            sheet.miss(key, unit="", label=label, group="network", source="Solana JSON-RPC",
                       endpoint=f"{primary} getEpochInfo", reason=err or "no result")

    samples, err = fetch.rpc(eps, "getRecentPerformanceSamples", [cfg["performance_samples"]])
    stamp = now_iso()
    if samples:
        ordered = sorted(samples, key=lambda s: s["slot"])
        raw["perf_samples"] = ordered
        # Anchor the sample strip to chain time so the tape is not merely "recent".
        anchor, _ = fetch.rpc(eps, "getBlockTime", [ordered[-1]["slot"]])
        raw["perf_anchor"] = anchor if isinstance(anchor, int) else None
        recent = ordered[-5:]
        secs = sum(s["samplePeriodSecs"] for s in recent)
        txs = sum(s["numTransactions"] for s in recent)
        non_vote = sum(s.get("numNonVoteTransactions") or 0 for s in recent)
        slots = sum(s["numSlots"] for s in recent)
        endpoint = f"{primary} getRecentPerformanceSamples"
        sheet.put("tps", txs / secs, unit="tx/s", label="Transactions per second", group="network",
                  source="Solana JSON-RPC", endpoint=endpoint, captured_at=stamp, precision=1,
                  note=f"mean over the last {secs} s of samples, votes included")
        sheet.put("non_vote_tps", non_vote / secs if non_vote else None, unit="tx/s",
                  label="Non-vote TPS", group="network", source="Solana JSON-RPC",
                  endpoint=endpoint, captured_at=stamp, precision=1,
                  note="consensus votes excluded")
        sheet.put("slot_time_ms", secs / slots * 1000 if slots else None, unit="ms",
                  label="Mean slot time", group="network", source="Solana JSON-RPC",
                  endpoint=endpoint, captured_at=stamp, precision=1,
                  note=f"design target {SLOT_TARGET_MS} ms")
        sheet.put("slot_rate", slots / secs if secs else None, unit="slot/s",
                  label="Slots produced per second", group="network", source="Solana JSON-RPC",
                  endpoint=endpoint, captured_at=stamp, precision=3)
    else:
        for key, label, unit in (("tps", "Transactions per second", "tx/s"),
                                 ("non_vote_tps", "Non-vote TPS", "tx/s"),
                                 ("slot_time_ms", "Mean slot time", "ms")):
            sheet.miss(key, unit=unit, label=label, group="network", source="Solana JSON-RPC",
                       endpoint=f"{primary} getRecentPerformanceSamples", reason=err or "no result")

    # True skipped-slot rate: leader slots assigned vs blocks actually produced.
    slot_now = sheet.metrics.get("slot", {}).get("value")
    if slot_now:
        span = cfg["block_production_slots"]
        prod, err = fetch.rpc(eps, "getBlockProduction",
                              [{"range": {"firstSlot": slot_now - span, "lastSlot": slot_now - 100}}])
        stamp = now_iso()
        if prod and prod.get("value", {}).get("byIdentity"):
            by = prod["value"]["byIdentity"]
            leader = sum(v[0] for v in by.values())
            produced = sum(v[1] for v in by.values())
            sheet.put("skipped_slot_rate", (1 - produced / leader) * 100 if leader else None,
                      unit="%", label="Skipped slots", group="network", source="Solana JSON-RPC",
                      endpoint=f"{primary} getBlockProduction", captured_at=stamp, precision=3,
                      note=f"leader slots {leader:,} vs blocks {produced:,} over {span:,} slots")
            sheet.put("leaders_in_window", len(by), unit="validators", label="Leaders in window",
                      group="network", source="Solana JSON-RPC",
                      endpoint=f"{primary} getBlockProduction", captured_at=stamp)
        else:
            sheet.miss("skipped_slot_rate", unit="%", label="Skipped slots", group="network",
                       source="Solana JSON-RPC", endpoint=f"{primary} getBlockProduction",
                       reason=err or "no result")

    fees, err = fetch.rpc(eps, "getRecentPrioritizationFees")
    stamp = now_iso()
    if fees:
        values = sorted(f["prioritizationFee"] for f in fees)
        median = statistics.median(values)
        p90 = values[int(len(values) * 0.9) - 1] if values else None
        sheet.put("median_priority_fee", median, unit="µlamports/CU", label="Median priority fee",
                  group="economy", source="Solana JSON-RPC",
                  endpoint=f"{primary} getRecentPrioritizationFees", captured_at=stamp,
                  precision=0, note=f"median over {len(values)} recent slots")
        sheet.put("p90_priority_fee", p90, unit="µlamports/CU", label="90th pct priority fee",
                  group="economy", source="Solana JSON-RPC",
                  endpoint=f"{primary} getRecentPrioritizationFees", captured_at=stamp, precision=0)
        sheet.put("base_fee_lamports", 5000, unit="lamports/sig", label="Base fee per signature",
                  group="economy", source="Solana protocol constant",
                  endpoint="fixed protocol parameter", captured_at=stamp,
                  note="not fetched: a protocol constant, stated so it is not mistaken for a reading")
    else:
        sheet.miss("median_priority_fee", unit="µlamports/CU", label="Median priority fee",
                   group="economy", source="Solana JSON-RPC",
                   endpoint=f"{primary} getRecentPrioritizationFees", reason=err or "no result")

    supply, err = fetch.rpc(eps, "getSupply", [{"excludeNonCirculatingAccountsList": True}])
    stamp = now_iso()
    circulating = total = None
    if supply and supply.get("value"):
        v = supply["value"]
        circulating = v["circulating"] / LAMPORTS
        total = v["total"] / LAMPORTS
        sheet.put("supply_circulating", circulating, unit="SOL", label="Circulating supply",
                  group="economy", source="Solana JSON-RPC", endpoint=f"{primary} getSupply",
                  captured_at=stamp, precision=0)
        sheet.put("supply_total", total, unit="SOL", label="Total supply", group="economy",
                  source="Solana JSON-RPC", endpoint=f"{primary} getSupply", captured_at=stamp,
                  precision=0)
    else:
        sheet.miss("supply_circulating", unit="SOL", label="Circulating supply", group="economy",
                   source="Solana JSON-RPC", endpoint=f"{primary} getSupply",
                   reason=err or "no result")

    inflation, err = fetch.rpc(eps, "getInflationRate")
    if inflation:
        sheet.put("inflation_rate", inflation.get("total", 0) * 100, unit="%/yr",
                  label="Inflation rate", group="economy", source="Solana JSON-RPC",
                  endpoint=f"{primary} getInflationRate", captured_at=now_iso(), precision=3)

    votes, err = fetch.rpc(eps, "getVoteAccounts")
    stamp = now_iso()
    if votes:
        current = votes.get("current", [])
        delinquent = votes.get("delinquent", [])
        endpoint = f"{primary} getVoteAccounts"
        stakes = sorted((v["activatedStake"] / LAMPORTS for v in current), reverse=True)
        active_stake = sum(stakes)
        raw["vote_accounts"] = {"current": current, "delinquent": delinquent}

        sheet.put("validators_active", len(current), unit="validators", label="Active validators",
                  group="validators", source="Solana JSON-RPC", endpoint=endpoint, captured_at=stamp)
        sheet.put("validators_delinquent", len(delinquent), unit="validators",
                  label="Delinquent validators", group="validators", source="Solana JSON-RPC",
                  endpoint=endpoint, captured_at=stamp,
                  note="a validator that has not voted in the recent slot window")
        sheet.put("stake_active", active_stake, unit="SOL", label="Active stake", group="validators",
                  source="Solana JSON-RPC", endpoint=endpoint, captured_at=stamp, precision=0)
        sheet.put("stake_delinquent", sum(v["activatedStake"] for v in delinquent) / LAMPORTS,
                  unit="SOL", label="Delinquent stake", group="validators",
                  source="Solana JSON-RPC", endpoint=endpoint, captured_at=stamp, precision=0)

        # Nakamoto coefficient: fewest validators whose combined stake exceeds 1/3.
        running = 0.0
        nakamoto = 0
        for s in stakes:
            running += s
            nakamoto += 1
            if active_stake and running > active_stake / 3:
                break
        sheet.put("nakamoto", nakamoto, unit="validators", label="Nakamoto coefficient",
                  group="validators", source="derived from getVoteAccounts", endpoint=endpoint,
                  captured_at=stamp, note="fewest validators holding more than 1/3 of active stake")

        if active_stake:
            sheet.put("stake_top10_share", sum(stakes[:10]) / active_stake * 100, unit="%",
                      label="Stake held by top 10", group="validators",
                      source="derived from getVoteAccounts", endpoint=endpoint,
                      captured_at=stamp, precision=2)
            sheet.put("stake_top100_share", sum(stakes[:100]) / active_stake * 100, unit="%",
                      label="Stake held by top 100", group="validators",
                      source="derived from getVoteAccounts", endpoint=endpoint,
                      captured_at=stamp, precision=2)
            weighted = sum(v["commission"] * v["activatedStake"] for v in current) / (active_stake * LAMPORTS)
            sheet.put("commission_weighted", weighted, unit="%", label="Stake-weighted commission",
                      group="validators", source="derived from getVoteAccounts", endpoint=endpoint,
                      captured_at=stamp, precision=2)
            sheet.put("commission_median", statistics.median([v["commission"] for v in current]),
                      unit="%", label="Median commission", group="validators",
                      source="derived from getVoteAccounts", endpoint=endpoint,
                      captured_at=stamp, precision=1)
        if circulating and active_stake:
            sheet.put("staked_share", active_stake / circulating * 100, unit="%",
                      label="Circulating supply staked", group="validators",
                      source="derived from getVoteAccounts and getSupply", endpoint=endpoint,
                      captured_at=stamp, precision=2)
    else:
        for key, label in (("validators_active", "Active validators"),
                           ("validators_delinquent", "Delinquent validators"),
                           ("nakamoto", "Nakamoto coefficient")):
            sheet.miss(key, unit="validators", label=label, group="validators",
                       source="Solana JSON-RPC", endpoint=f"{primary} getVoteAccounts",
                       reason=err or "no result")
    return raw


def build_perf_strip(rpc_raw: dict) -> dict:
    """The node hands back up to 12 h of per-minute samples. That is the tape.

    Each sample carries a slot, not a clock reading. The newest slot is turned
    into chain time with getBlockTime and the rest are stepped back by the
    sample period, which is stated on the page rather than passed off as a
    direct reading.
    """
    samples = rpc_raw.get("perf_samples") or []
    if len(samples) < 4:
        return {}
    anchor = rpc_raw.get("perf_anchor")
    basis = "getBlockTime on the newest sample"
    if not anchor:
        anchor = int(time.time())
        basis = "collection time (getBlockTime returned nothing)"
    period = samples[-1].get("samplePeriodSecs") or 60
    n = len(samples)
    t = [anchor - (n - 1 - i) * period for i in range(n)]
    common = {
        "source": "Solana JSON-RPC", "endpoint": "getRecentPerformanceSamples",
        "captured_at": now_iso(), "step": f"{period} s",
        "note": f"sample clock derived from {basis} stepped back by {period} s per sample",
        "t": t,
    }
    out = {
        "network_tps": {**common, "label": "Transactions per second", "unit": "tx/s",
                        "v": [round(s["numTransactions"] / (s["samplePeriodSecs"] or period), 1)
                              for s in samples]},
        "network_slot_time": {**common, "label": "Slot time", "unit": "ms",
                              "v": [round((s["samplePeriodSecs"] or period) / s["numSlots"] * 1000, 1)
                                    if s.get("numSlots") else None for s in samples]},
    }
    if any(s.get("numNonVoteTransactions") for s in samples):
        out["network_non_vote_tps"] = {
            **common, "label": "Non-vote transactions per second", "unit": "tx/s",
            "v": [round((s.get("numNonVoteTransactions") or 0) / (s["samplePeriodSecs"] or period), 1)
                  for s in samples]}
    return out


def collect_market(fetch: Fetcher, cfg: dict, sheet: Sheet) -> dict:
    """Price, TVL, stablecoins, DEX volume, chain fees. All public, no key."""
    days = cfg["history"]["external_days"]
    external: dict = {}

    url = ("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
           "&include_24hr_vol=true&include_24hr_change=true&include_market_cap=true")
    price, err = fetch.get(url)
    stamp = now_iso()
    if price and price.get("solana"):
        p = price["solana"]
        for key, val, unit, label, prec in (
            ("price_usd", p.get("usd"), "USD", "SOL price", 4),
            ("market_cap", p.get("usd_market_cap"), "USD", "Market capitalisation", 0),
            ("volume_24h", p.get("usd_24h_vol"), "USD", "Spot volume, 24 h", 0),
            ("price_change_24h", p.get("usd_24h_change"), "%", "Price change, 24 h", 2),
        ):
            sheet.put(key, num(val), unit=unit, label=label, group="economy",
                      source="CoinGecko", endpoint="api.coingecko.com /simple/price",
                      captured_at=stamp, precision=prec)
    else:
        sheet.miss("price_usd", unit="USD", label="SOL price", group="economy", source="CoinGecko",
                   endpoint="api.coingecko.com /simple/price", reason=err or "no result")

    chart, err = fetch.get("https://api.coingecko.com/api/v3/coins/solana/market_chart"
                           f"?vs_currency=usd&days={days}&interval=daily")
    if chart and chart.get("prices"):
        external["price_usd"] = {
            "label": "SOL price", "unit": "USD", "source": "CoinGecko",
            "endpoint": "api.coingecko.com /coins/solana/market_chart",
            "captured_at": now_iso(), "step": "1 day",
            "t": [int(p[0] / 1000) for p in chart["prices"]],
            "v": [round(p[1], 4) for p in chart["prices"]],
        }

    tvl, err = fetch.get("https://api.llama.fi/v2/historicalChainTvl/Solana")
    stamp = now_iso()
    if tvl:
        tail = tvl[-days:]
        external["tvl_usd"] = {
            "label": "DeFi TVL on Solana", "unit": "USD", "source": "DefiLlama",
            "endpoint": "api.llama.fi /v2/historicalChainTvl/Solana",
            "captured_at": stamp, "step": "1 day",
            "t": [p["date"] for p in tail], "v": [round(p["tvl"]) for p in tail],
        }
        sheet.put("tvl_usd", tail[-1]["tvl"], unit="USD", label="DeFi TVL", group="economy",
                  source="DefiLlama", endpoint="api.llama.fi /v2/historicalChainTvl/Solana",
                  captured_at=stamp, precision=0)
    else:
        sheet.miss("tvl_usd", unit="USD", label="DeFi TVL", group="economy", source="DefiLlama",
                   endpoint="api.llama.fi /v2/historicalChainTvl/Solana", reason=err or "no result")

    stables, err = fetch.get("https://stablecoins.llama.fi/stablecoinchains")
    stamp = now_iso()
    if stables:
        row = next((r for r in stables if r.get("name") == "Solana"), None)
        value = (row or {}).get("totalCirculatingUSD", {}).get("peggedUSD")
        sheet.put("stablecoin_supply", num(value), unit="USD", label="Stablecoins on Solana",
                  group="economy", source="DefiLlama", endpoint="stablecoins.llama.fi /stablecoinchains",
                  captured_at=stamp, precision=0,
                  error=None if value else "Solana row absent from response")
    else:
        sheet.miss("stablecoin_supply", unit="USD", label="Stablecoins on Solana", group="economy",
                   source="DefiLlama", endpoint="stablecoins.llama.fi /stablecoinchains",
                   reason=err or "no result")

    for kind, key, label in (("dexs", "dex_volume_24h", "DEX volume, 24 h"),
                             ("fees", "chain_fees_24h", "Chain fees, 24 h")):
        url = (f"https://api.llama.fi/overview/{kind}/solana"
               "?excludeTotalDataChartBreakdown=true")
        payload, err = fetch.get(url)
        stamp = now_iso()
        if payload:
            sheet.put(key, num(payload.get("total24h")), unit="USD", label=label, group="economy",
                      source="DefiLlama", endpoint=f"api.llama.fi /overview/{kind}/solana",
                      captured_at=stamp, precision=0)
            sheet.put(key + "_change", num(payload.get("change_1d")), unit="%",
                      label=label + ", change", group="economy", source="DefiLlama",
                      endpoint=f"api.llama.fi /overview/{kind}/solana", captured_at=stamp,
                      precision=2)
            chart = payload.get("totalDataChart") or []
            if chart:
                tail = chart[-days:]
                external[key] = {
                    "label": label.split(",")[0], "unit": "USD", "source": "DefiLlama",
                    "endpoint": f"api.llama.fi /overview/{kind}/solana",
                    "captured_at": stamp, "step": "1 day",
                    "t": [int(p[0]) for p in tail], "v": [round(p[1]) for p in tail],
                }
        else:
            sheet.miss(key, unit="USD", label=label, group="economy", source="DefiLlama",
                       endpoint=f"api.llama.fi /overview/{kind}/solana", reason=err or "no result")
    return external


def collect_clients(fetch: Fetcher, sheet: Sheet, rpc_raw: dict) -> tuple[list[dict], dict]:
    """Validator identity and client version. Stake numbers stay RPC-authoritative."""
    data, err = fetch.get("https://api.stakewiz.com/validators")
    if not data:
        sheet.gap("validator_client_versions",
                  "the RPC endpoint does not expose the software version of other nodes; "
                  f"the directory used for names and versions did not answer ({err})",
                  ["api.stakewiz.com/validators"])
        return [], {}
    stamp = now_iso()
    by_vote = {v.get("vote_identity"): v for v in data if v.get("vote_identity")}

    current = rpc_raw.get("vote_accounts", {}).get("current", [])
    versions: dict[str, float] = {}
    total = 0.0
    for v in current:
        stake = v["activatedStake"] / LAMPORTS
        total += stake
        ver = (by_vote.get(v["votePubkey"]) or {}).get("version") or "unreported"
        versions[ver] = versions.get(ver, 0.0) + stake
    if total:
        sheet.put("client_versions", len(versions), unit="versions", label="Client versions in use",
                  group="upgrades", source="Solana JSON-RPC stake x Stakewiz version",
                  endpoint="api.stakewiz.com/validators", captured_at=stamp)
    table = sorted(
        ({"version": k, "stake": round(v), "share": round(v / total * 100, 2) if total else None}
         for k, v in versions.items()),
        key=lambda r: -r["stake"])[:8]
    return table, by_vote


def build_validator_table(rpc_raw: dict, fetch_names: dict, limit: int) -> list[dict]:
    current = rpc_raw.get("vote_accounts", {}).get("current", [])
    rows = sorted(current, key=lambda v: -v["activatedStake"])[:limit]
    total = sum(v["activatedStake"] for v in current) or 1
    out = []
    for v in rows:
        info = fetch_names.get(v["votePubkey"]) or {}
        out.append({
            "vote": v["votePubkey"],
            "name": info.get("name") or None,
            "stake": round(v["activatedStake"] / LAMPORTS),
            "share": round(v["activatedStake"] / total * 100, 3),
            "commission": v["commission"],
        })
    return out


def build_stake_buckets(rpc_raw: dict) -> list[dict]:
    current = rpc_raw.get("vote_accounts", {}).get("current", [])
    if not current:
        return []
    edges = [0, 1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000, 5_000_000, float("inf")]
    names = ["<1k", "1k-10k", "10k-50k", "50k-100k", "100k-500k", "500k-1M", "1M-5M", ">5M"]
    counts = [0] * len(names)
    stake = [0.0] * len(names)
    for v in current:
        s = v["activatedStake"] / LAMPORTS
        for i in range(len(names)):
            if edges[i] <= s < edges[i + 1]:
                counts[i] += 1
                stake[i] += s
                break
    total = sum(stake) or 1
    return [{"bucket": names[i], "validators": counts[i], "stake": round(stake[i]),
             "share": round(stake[i] / total * 100, 2)} for i in range(len(names))]


def build_commission_hist(rpc_raw: dict) -> list[dict]:
    current = rpc_raw.get("vote_accounts", {}).get("current", [])
    if not current:
        return []
    buckets = {"0%": 0, "1-4%": 0, "5%": 0, "6-9%": 0, "10%": 0, "11-99%": 0, "100%": 0}
    for v in current:
        c = v["commission"]
        key = ("0%" if c == 0 else "5%" if c == 5 else "10%" if c == 10 else "100%" if c == 100
               else "1-4%" if c < 5 else "6-9%" if c < 10 else "11-99%")
        buckets[key] += 1
    return [{"bucket": k, "validators": v} for k, v in buckets.items()]


def collect_upgrades(fetch: Fetcher, sheet: Sheet) -> dict:
    """What is coming to the network: client releases and improvement documents."""
    headers = {}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    out: dict = {"releases": [], "simd": [], "source": "GitHub REST API"}
    rel, err = fetch.get("https://api.github.com/repos/anza-xyz/agave/releases?per_page=6", headers)
    if rel:
        out["releases"] = [{
            "tag": r["tag_name"], "name": r.get("name") or r["tag_name"],
            "published_at": r.get("published_at"), "prerelease": r.get("prerelease", False),
            "url": r.get("html_url"),
        } for r in rel]
    else:
        sheet.gap("client_releases", f"GitHub releases did not answer ({err})",
                  ["api.github.com/repos/anza-xyz/agave/releases"])

    simd, err = fetch.get("https://api.github.com/repos/solana-foundation/"
                          "solana-improvement-documents/pulls?state=open&sort=updated"
                          "&direction=desc&per_page=6", headers)
    if simd:
        out["simd"] = [{
            "number": p["number"], "title": p["title"], "updated_at": p.get("updated_at"),
            "url": p.get("html_url"),
        } for p in simd]
    else:
        sheet.gap("simd_proposals", f"GitHub pull requests did not answer ({err})",
                  ["api.github.com/repos/solana-foundation/solana-improvement-documents/pulls"])
    return out


# ----------------------------------------------------------------- history


HISTORY_KEYS = [
    "tps", "non_vote_tps", "slot_time_ms", "skipped_slot_rate", "slot", "block_height",
    "epoch_progress", "tx_count_total", "validators_active", "validators_delinquent",
    "nakamoto", "stake_active", "staked_share", "stake_top10_share", "median_priority_fee",
    "price_usd", "tvl_usd", "stablecoin_supply", "dex_volume_24h", "chain_fees_24h",
    "supply_circulating",
]


def append_history(sheet: Sheet, stamp: datetime) -> None:
    os.makedirs(HISTORY, exist_ok=True)
    row = {"t": int(stamp.timestamp())}
    for key in HISTORY_KEYS:
        value = sheet.metrics.get(key, {}).get("value")
        if isinstance(value, (int, float)):
            row[key] = value
    path = os.path.join(HISTORY, stamp.strftime("%Y-%m") + ".jsonl")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, separators=(",", ":")) + "\n")


def read_history(keep_days: int) -> list[dict]:
    if not os.path.isdir(HISTORY):
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).timestamp()
    rows: list[dict] = []
    for name in sorted(os.listdir(HISTORY)):
        if not name.endswith(".jsonl"):
            continue
        with open(os.path.join(HISTORY, name), "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("t", 0) >= cutoff:
                    rows.append(row)
    rows.sort(key=lambda r: r["t"])
    return rows


def derive_daily_transactions(rows: list[dict], sheet: Sheet) -> None:
    """Transactions per day measured from the cumulative counter, not estimated."""
    counted = [r for r in rows if "tx_count_total" in r and "t" in r]
    if len(counted) < 2:
        tps = sheet.metrics.get("non_vote_tps", {}).get("value")
        sheet.put("tx_per_day", tps * 86400 if tps else None, unit="tx/day",
                  label="Transactions per day", group="growth",
                  source="derived from getRecentPerformanceSamples", endpoint="projection",
                  captured_at=now_iso(), precision=0,
                  error=None if tps else "no performance samples",
                  note="projected from the current non-vote rate; replaced by a measured value "
                       "once two snapshots at least 6 h apart exist")
        return
    newest = counted[-1]
    target = newest["t"] - 86400
    older = min(counted[:-1], key=lambda r: abs(r["t"] - target))
    span = newest["t"] - older["t"]
    if span < 6 * 3600:
        older = counted[0]
        span = newest["t"] - older["t"]
    if span < 1800:
        # too little history to divide by: say so instead of printing a wild rate
        tps = sheet.metrics.get("non_vote_tps", {}).get("value")
        sheet.put("tx_per_day", tps * 86400 if tps else None, unit="tx/day",
                  label="Transactions per day", group="growth",
                  source="derived from getRecentPerformanceSamples", endpoint="projection",
                  captured_at=now_iso(), precision=0,
                  note=f"projected from the current non-vote rate; only "
                       f"{span / 60:.0f} min of history collected so far")
        return
    delta = newest["tx_count_total"] - older["tx_count_total"]
    sheet.put("tx_per_day", delta / span * 86400, unit="tx/day", label="Transactions per day",
              group="growth", source="measured: difference of getEpochInfo.transactionCount",
              endpoint="own history", captured_at=now_iso(), precision=0,
              note=f"{delta:,} transactions over {span / 3600:.1f} h of collected history")


def build_series(rows: list[dict], points: int) -> dict:
    rows = rows[-points:]
    series = {"t": [r["t"] for r in rows], "keys": {}}
    for key in HISTORY_KEYS:
        column = [r.get(key) for r in rows]
        if sum(1 for c in column if c is not None) >= 2:
            series["keys"][key] = column
    return series


# --------------------------------------------------------------- anomalies


def detect(t: list[int], values: list, cfg: dict, name: str, label: str, unit: str,
           source: str) -> tuple[list[dict], list[dict]]:
    """Rolling mean and standard deviation; a point beyond z sigma is an outlier.

    The window ends *before* the point being judged, so a spike cannot widen the
    band that is supposed to catch it.
    """
    window = cfg["window"]
    z_threshold = cfg["z_threshold"]
    min_points = cfg["min_points"]
    min_rel_sd = cfg["min_relative_sd"]

    band: list[dict] = []
    found: list[dict] = []
    for i, value in enumerate(values):
        prior = [v for v in values[max(0, i - window):i] if isinstance(v, (int, float))]
        if len(prior) < min_points or not isinstance(value, (int, float)):
            band.append({"i": i, "mean": None, "sd": None})
            continue
        mean = statistics.fmean(prior)
        sd = statistics.pstdev(prior)
        floor = abs(mean) * min_rel_sd
        effective_sd = max(sd, floor)
        band.append({"i": i, "mean": round(mean, 6), "sd": round(effective_sd, 6)})
        if effective_sd <= 0:
            continue
        z = (value - mean) / effective_sd
        if abs(z) >= z_threshold:
            found.append({
                "series": name, "label": label, "unit": unit, "source": source,
                "at": t[i], "index": i, "value": value, "mean": round(mean, 6),
                "sd": round(effective_sd, 6), "z": round(z, 2),
                "direction": "above" if z > 0 else "below",
                "deviation_pct": round((value - mean) / mean * 100, 2) if mean else None,
            })
    return band, found


# ------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cfg = load_config()
    started = time.time()
    stamp = datetime.now(timezone.utc)
    fetch = Fetcher(cfg)
    sheet = Sheet()

    rpc_raw = collect_rpc(fetch, cfg, sheet)
    external = build_perf_strip(rpc_raw)
    external.update(collect_market(fetch, cfg, sheet))
    client_versions, names = collect_clients(fetch, sheet, rpc_raw)
    upgrades = collect_upgrades(fetch, sheet)

    sheet.gap("daily_active_addresses",
              "no public endpoint exposes it without an API key: the JSON-RPC node cannot "
              "aggregate accounts across blocks, and every indexer that can (Dune, Flipside, "
              "Artemis, Solscan Pro) requires a registered key. Transactions per day, measured "
              "from the cumulative on-chain counter, is published instead and is stated as such.",
              ["api.mainnet-beta.solana.com", "api.llama.fi/userData/activeUsers/chain$solana",
               "api.llama.fi/activeUsers"])

    if not args.dry_run:
        append_history(sheet, stamp)
    rows = read_history(cfg["history"]["keep_days"])
    derive_daily_transactions(rows, sheet)
    series = build_series(rows, cfg["history"]["series_points"])

    anomalies: list[dict] = []
    bands: dict = {}
    for key, column in series["keys"].items():
        meta = sheet.metrics.get(key, {})
        band, found = detect(series["t"], column, cfg["anomaly"], key,
                             meta.get("label", key), meta.get("unit", ""),
                             meta.get("source", "own history"))
        bands[key] = band
        anomalies.extend(found)
    for key, block in external.items():
        band, found = detect(block["t"], block["v"], cfg["anomaly"], "ext:" + key,
                             block["label"], block["unit"], block["source"])
        block["band"] = band
        anomalies.extend(found)
    anomalies.sort(key=lambda a: (-a["at"], -abs(a["z"])))

    ok = sum(1 for e in fetch.log if e["ok"])
    payload = {
        "schema": 1,
        "generated_at": now_iso(),
        "run": {
            "duration_ms": int((time.time() - started) * 1000),
            "requests": len(fetch.log), "ok": ok, "failed": len(fetch.log) - ok,
            "interval_minutes": cfg["collect_interval_minutes"],
        },
        "anomaly_config": cfg["anomaly"],
        "metrics": sheet.metrics,
        "series": {**series, "bands": bands},
        "external": external,
        "anomalies": anomalies[:60],
        "anomaly_count": len(anomalies),
        "tables": {
            "top_validators": build_validator_table(rpc_raw, names, cfg["top_validators"]),
            "stake_buckets": build_stake_buckets(rpc_raw),
            "commission_hist": build_commission_hist(rpc_raw),
            "client_versions": client_versions,
        },
        "upgrades": upgrades,
        "gaps": sheet.gaps,
        "requests": fetch.log,
    }

    filled = sum(1 for m in sheet.metrics.values() if m["value"] is not None)
    print(f"metrics {filled}/{len(sheet.metrics)} filled, "
          f"requests {ok}/{len(fetch.log)} ok, "
          f"history {len(rows)} rows, anomalies {len(anomalies)}, "
          f"{payload['run']['duration_ms']} ms")
    for key, metric in sheet.metrics.items():
        if metric["value"] is None:
            print(f"  gap: {key} <- {metric['error']}")

    if args.dry_run:
        return 0

    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "latest.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"), ensure_ascii=False)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
