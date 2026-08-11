# `baked-secret` precision

`baked-secret` is the only `error`-severity rule this extension ships, so its
false-positive rate is the whole question. This directory is the measurement and
the means to redo it.

## Result

    population                     files   0.0.4 baked-secret   0.0.5 baked-secret   0.0.5 secret-arg-to-env
    unbiased                         114                    6                    0                        0
    score-filtered                    32                    5                    0                        1

## The two populations are not added together

- **unbiased** (114 files) — every Dockerfile that could be fetched, kept whatever was in it. This is the population the false-positive rate is quoted over.
- **score-filtered** (32 files) — the output of a survey scanner that keeps only repositories scoring above zero. It over-represents bad files, and a file whose only defect would be `baked-secret` scores zero and is dropped, so this population cannot be used for a rate in either direction. It is here because it contains the one true positive.

They share **26** repositories, so `score-filtered` contributes only **6** that `unbiased` does not already have. Adding 114 and 32 would be a wrong denominator, which is why the table keeps them apart. `corpus.json` lists the shared set explicitly.

## Reproducing it

`corpus.json` gives the repository, path and branch of every file measured. Fetch
them yourself, run `node test.js` for the unit tests, and run `analyze.js` over the
fetched files — the rule is a pure function of the Dockerfile text, so the same
bytes give the same hits. Nothing here depends on trusting this repository.

`hits.md` lists every hit with the instruction that produced it. Read them and
decide for yourself whether each is a false positive; that is the point of
publishing them rather than publishing a percentage.

