// One hook for every request in the app.
//
// The thing it exists to get right is not loading spinners, it is STALE
// RESPONSES. Every panel refetches when the filter changes, and a slow request
// for the old filter can land after a fast one for the new filter — leaving the
// dashboard showing YouTube numbers under an "X" heading, with no error anywhere
// and nothing on screen admitting it. That is the same class of failure the
// server guards against by rejecting unknown query parameters, and it deserves
// the same seriousness here.
//
// So each run is tagged and a result is only committed if its run is still the
// current one.

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface AsyncState<T> {
    data: T | null;
    error: ApiError | null;
    loading: boolean;
    /** Re-run the request. Used by the retry buttons and the manual refresh. */
    reload: () => void;
}

export function useAsync<T>(run: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<ApiError | null>(null);
    const [loading, setLoading] = useState(true);
    const [nonce, setNonce] = useState(0);

    // Incremented per request. A response whose id is not the latest is dropped.
    const latest = useRef(0);

    // `run` is a fresh closure every render, so it cannot be a dependency
    // without looping. The caller's `deps` are the real inputs.
    const runRef = useRef(run);
    runRef.current = run;

    useEffect(() => {
        const id = ++latest.current;
        setLoading(true);

        runRef
            .current()
            .then((value) => {
                if (latest.current !== id) return;
                setData(value);
                setError(null);
            })
            .catch((caught: unknown) => {
                if (latest.current !== id) return;
                setError(
                    caught instanceof ApiError
                        ? caught
                        : new ApiError(0, "UNKNOWN", caught instanceof Error ? caught.message : String(caught)),
                );
                setData(null);
            })
            .finally(() => {
                if (latest.current !== id) return;
                setLoading(false);
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, nonce]);

    const reload = useCallback(() => setNonce((n) => n + 1), []);

    return { data, error, loading, reload };
}
