# Offline comparison explanation controls

`booking-ledger.js` is an authored normalized pair. It models the public task's
single editable-file boundary without changing the frozen evaluation task, skill,
or oracle. Its measurements/check results are synthetic, not model-quality data.
`booking-ledger.expected.md` records the intended report meaning before projection.

Run the complete offline artifact path into a new output directory:

```sh
node test-support/audit-explanation/verify.mjs /tmp/new-m1-report-controls
```

The verifier exports and reopens seventeen controls, compares full and compact
explanations, and exercises `audit diff`, `show`, and Markdown export with a missing
source home. Optional trailing arguments select existing normalized comparison
JSON files for read-only native-evidence replay; those unmatched historical
comparisons must remain ineligible for same-task claims. It never starts a model
or native client, reads live profiles, or writes the selected inputs. Outputs use
exclusive creation; choose a new directory for another verification record.

Human review and consistency are not measured. The private report packet may
contain retained native metadata; only the synthetic example is public.
