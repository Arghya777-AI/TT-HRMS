/**
 * useFaceEngine — one shared load of the face nets for the whole gate surface.
 *
 * Mounted at the root of `/kiosk`, so the 6.4 MB recognition net downloads while
 * the guard is pairing or keying a PIN rather than when the first person walks up
 * to the camera.
 */
import { useEffect, useState } from "react";
import { warmFaceEngine, type EngineStatus } from "../lib/engine";

export function useFaceEngine(): EngineStatus {
  const [status, setStatus] = useState<EngineStatus>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void warmFaceEngine().then(
      () => {
        if (!cancelled) setStatus({ kind: "ready" });
      },
      () => {
        if (!cancelled) setStatus({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
