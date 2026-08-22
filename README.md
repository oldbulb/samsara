# samsara

A self-iterating agent host built on DeepSeek Harness (dsh). Each iteration is a disposable
child scope; the primary object is an experiment ledger (propose / run / judge / keep-or-drop);
host state is the set of kept rows on `main`.

See `CLAUDE.md` for the design contract and `docs/research/README.md` for the design record.
