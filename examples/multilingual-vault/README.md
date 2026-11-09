# Multilingual sample vault

One note per language, each typeset with its detected language, direction,
digits and fonts. Open this folder in NoteZ, or compile every note with:

    cd core && NOTEZ_VAULT=../examples/multilingual-vault cargo test --release vault_compiles -- --ignored --nocapture
