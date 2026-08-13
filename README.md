# Solana Tape

A public statistics page for the Solana network, drawn like a chart recorder: the data is
ink on paper, the ink fades as the paper ages, and an outlier makes the pen press harder.

**Live page:** https://smirnov-artur.github.io/solana-tape/
**Raw data:** [`data/latest.json`](data/latest.json) — one file, plain JSON, readable without the page.

Everything is read-only. The collector calls public endpoints that require no key, and the
page fetches one JSON file from this repository. No wallet, no signing, no transactions, no
trackers, no CDN, no external fonts.

---

## What it shows

| Group | Readings |
|---|---|
| **Network** | transactions per second (with and without votes), mean slot time against the 400 ms target, slots produced per second, skipped-slot rate measured from leader schedule against blocks produced, block height, absolute slot, node health, leaders in the window |
| **Epoch** | epoch number, slot in epoch, slots remaining, share complete — measured, plus a projection that advances live at the measured slot rate and is drawn differently so the two are never confused |
| **Validators** | active against delinquent, one mark per validator, active and delinquent stake, Nakamoto coefficient, share held by the top 10 and top 100, stake-weighted and median commission, share of circulating supply staked, the twelve largest by stake, stake concentration curve, commission histogram, stake by validator count band |
| **Economy** | SOL price, market capitalisation, 24 h spot volume, DeFi TVL, stablecoins issued on Solana, DEX volume per day, chain fees per day, median and 90th-percentile priority fee, circulating and total supply, inflation rate |
| **Growth** | transactions per day, cumulative transaction count, DEX volume change, price change |
| **What is coming** | Agave client releases, improvement documents (SIMDs) currently in review, and the share of active stake running each client version |

Ninety days of history come with the market series. The per-minute network tape comes from the
node itself. Everything else accumulates in `data/history/` as the workflow runs.

## Where the numbers come from

| Source | Used for | Key needed |
|---|---|---|
| `api.mainnet-beta.solana.com` (JSON-RPC) | slots, epoch, performance samples, block production, vote accounts, supply, inflation, priority fees | no |
| `api.llama.fi` | DeFi TVL, DEX volume, chain fees | no |
| `stablecoins.llama.fi` | stablecoins issued on Solana | no |
| `api.coingecko.com` | price, market capitalisation, spot volume | no |
| `api.github.com` | Agave releases, SIMD pull requests | no (uses `GITHUB_TOKEN` in Actions only to raise the rate limit) |
| `api.stakewiz.com` | validator display names and client versions | no |

Only read methods are called: `getHealth`, `getSlot`, `getEpochInfo`,
`getRecentPerformanceSamples`, `getBlockTime`, `getBlockProduction`, `getRecentPrioritizationFees`,
`getSupply`, `getInflationRate`, `getVoteAccounts`.

Every metric in `latest.json` carries `source`, `endpoint` and `captured_at`. The page prints
all of it in the last section, and hovering any number shows the same three lines. Values that
are computed rather than read say so in their `source` field ("derived from …"). Stake figures
always come from the RPC node even where a name or a version string comes from a directory.

**A source that does not answer produces a gap, not a guess.** The metric is written with
`value: null` and the reason, the page prints a dash and the error, and the row is marked in
the source table. One metric is a permanent gap and is documented as such on the page:

> **Daily active addresses.** No public endpoint exposes it without an API key. A JSON-RPC node
> cannot aggregate accounts across blocks, and the indexers that can — Dune, Flipside, Artemis,
> Solscan Pro — all require registration. Transactions per day, measured from the cumulative
> on-chain counter, is published instead and is labelled as a different thing.

## Outlier detection

Each series is compared against its own rolling mean and standard deviation:

```
window w = 24 readings ending immediately BEFORE the point being judged
z = (value − mean) / max(sd, |mean| × 0.0005)
outlier when |z| ≥ threshold        (default 3.0)
```

The window stops before the point under test, so a spike cannot inflate the band that is
supposed to catch it. A floor under the standard deviation keeps a flat series from flagging
rounding noise. A band needs at least 8 prior readings before it will judge anything.

Both the mean and the deviation for every point are stored in `latest.json`, so **the threshold
slider on the page recomputes the whole log in the browser** — no round trip, and the charts,
the readouts and the margin notes all move together. Outliers are drawn twice: as a thicker red
stroke on the trace and as a tick in the top margin of the panel.

Defaults live in `config.json` under `anomaly` and apply to the collector; the slider only
changes what you are looking at.

## Running it

```bash
git clone https://github.com/smirnov-artur/solana-tape
cd solana-tape

python scripts/collect.py            # collect and write data/
python scripts/collect.py --dry-run  # collect and report, write nothing

python -m http.server 8000           # then open http://localhost:8000
```

Python 3.9 or newer, standard library only. No dependencies, no build step, no bundler.
The page is static files; opening `index.html` over `file://` will not work because it fetches
`data/latest.json`, so serve the folder.

The collector prints a one-line summary and names every gap:

```
metrics 42/42 filled, requests 18/18 ok, history 3 rows, anomalies 26, 13332 ms
```

## Changing the interval

`config.json` is the only place the schedule is written:

```json
{ "collect_interval_minutes": 30 }
```

GitHub Actions cannot read a cron out of a file, so after changing it run:

```bash
python scripts/schedule.py --write
```

That rewrites the `cron:` line in `.github/workflows/collect.yml`. The workflow checks the two
against each other on every run and fails if they ever drift apart, so the interval cannot
quietly become two different numbers. The same file holds the anomaly thresholds, the RPC
endpoints to try in order, how much history to keep and how many points to publish.

The workflow also accepts `workflow_dispatch`, so a run can be triggered by hand from the
Actions tab.

## Layout

```
config.json               interval, thresholds, endpoints — the single source of truth
scripts/collect.py        collector: fetch, derive, detect outliers, write data/
scripts/schedule.py       keeps the workflow cron in step with config.json
.github/workflows/        cron + manual run, commits data back to the repository
data/latest.json          everything the page needs, in one request
data/history/YYYY-MM.jsonl  one compact line per run, kept for trends
index.html, assets/       the page: hand-written canvas charts, no libraries
```

## Notes on the page

Light is paper and dark is the room the recorder stands in at night — the two themes are
different objects, not an inverted copy. Colour carries exactly one meaning: red marks an
outlier. Numbers are set in a monospace face with tabular figures so digits line up by place
across every table and readout. The whole page works from the keyboard, honours
`prefers-reduced-motion`, and the charts are redrawn rather than rescaled when the theme or
the window changes.

The freshness of the data is shown as a state of the instrument, not only as a timestamp: while
the last run is recent the pen is down and the epoch projection creeps forward in real time;
once the newest run is older than two and a half intervals the pen lifts and says so.

## Licence

MIT, see [LICENSE](LICENSE). The data belongs to the sources listed above and is subject to
their terms.
