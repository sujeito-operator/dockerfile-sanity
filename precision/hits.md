# Every `baked-secret` hit, with the instruction that produced it

0.0.4 matched the KEY as a bare substring and never read the VALUE. 0.0.5 requires
both to look like a credential. Both implementations are run over the same bytes in
one pass; the lines below are verbatim from the Dockerfile named above them.

## Population: unbiased

every Dockerfile that could be fetched, kept whatever was in it. This is the population the false-positive rate is quoted over.

### NVIDIA/NeMo-Retriever/Dockerfile

    0.0.4 error    L18  DOWNLOAD_DEFAULT_TOKENIZER="False"

### PostHog/posthog/Dockerfile

    0.0.4 error    L185  TIKTOKEN_CACHE_DIR=/code/.tiktoken_cache
    0.0.4 error    L394  TIKTOKEN_CACHE_DIR=/code/.tiktoken_cache

### open-webui/open-webui/Dockerfile

    0.0.4 error    L18  USE_TIKTOKEN_ENCODING_NAME="cl100k_base"
    0.0.4 error    L79  OPENAI_API_KEY="" \ WEBUI_SECRET_KEY="" SCARF_NO_ANALYTICS=true DO_NOT_TRACK=true ANONYMIZED_TELEMETRY=false
    0.0.4 error    L97  TIKTOKEN_ENCODING_NAME="cl100k_base" \ TIKTOKEN_CACHE_DIR="/app/backend/data/cache/tiktoken"

## Population: score-filtered

the output of a survey scanner that keeps only repositories scoring above zero. It over-represents bad files, and a file whose only defect would be `baked-secret` scores zero and is dropped, so this population cannot be used for a rate in either direction. It is here because it contains the one true positive.

### NVIDIA/NeMo-Retriever/Dockerfile

    0.0.4 error    L18  DOWNLOAD_DEFAULT_TOKENIZER="False"

### PostHog/posthog/Dockerfile

    0.0.4 error    L185  TIKTOKEN_CACHE_DIR=/code/.tiktoken_cache
    0.0.4 error    L394  TIKTOKEN_CACHE_DIR=/code/.tiktoken_cache

### PrefectHQ/prefect/Dockerfile

    0.0.4 error    L50  VITE_AMPLITUDE_API_KEY=""
    0.0.4 error    L51  VITE_AMPLITUDE_API_KEY=$VITE_AMPLITUDE_API_KEY
    0.0.5 warning  L51  secret-arg-to-env  VITE_AMPLITUDE_API_KEY=$VITE_AMPLITUDE_API_KEY

