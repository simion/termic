import { create } from "zustand";
import type { DeliveryDetails, DeliveryRepo, DeliveryRequest, DeliveryResult, DeliveryIdentity } from "@/lib/types";
import { taskDeliveryRepos, taskDeliveryRequests, taskDeliveryDetails, taskDeliveryResults } from "@/lib/ipc";
import { changedIdentity } from "@/lib/delivery";

interface Entry {
  repos: DeliveryRepo[];
  requests: DeliveryRequest[];
  details: Record<string, DeliveryDetails>;
  /** When each detail was last probed — refresh() does not re-probe, so
   *  this is the evidence age the stale-warning reports. */
  detailsAt: Record<string, number>;
  results: DeliveryResult[];
  loading: boolean;
  error: string | null;
  fetchedAt: number;
}
const empty = (): Entry => ({ repos: [], requests: [], details: {}, detailsAt: {}, results: [], loading: false, error: null, fetchedAt: 0 });
export const useDelivery = create<{
  byTask: Record<string, Entry>;
  edits: Record<string, string>;
  edit: (key: string, body: string | undefined) => void;
  refresh: (id: string) => Promise<void>;
  details: (id: string, expected: DeliveryIdentity) => Promise<void>;
  results: (id: string, results: DeliveryResult[]) => void;
}>((set, get) => ({
  byTask: {},
  edits: {},
  edit: (key, body) => set(s => { const edits = { ...s.edits }; if (body === undefined) delete edits[key]; else edits[key] = body; return { edits }; }),
  refresh: async id => {
    if (get().byTask[id]?.loading) return;
    set(s => ({ byTask: { ...s.byTask, [id]: { ...(s.byTask[id] ?? empty()), loading: true } } }));
    try {
      const [repos, requests, results] = await Promise.all([taskDeliveryRepos(id), taskDeliveryRequests(id), taskDeliveryResults(id)]);
      set(s => {
        const cur = s.byTask[id] ?? empty();
        const keep = (dir: string) => {
          const detail = cur.details[dir];
          const now = repos.find(r => r.dir_name === dir)?.identity;
          return !!detail && !!now && !changedIdentity(detail.identity, now);
        };
        const details = Object.fromEntries(Object.entries(cur.details).filter(([dir]) => keep(dir)));
        const detailsAt = Object.fromEntries(Object.entries(cur.detailsAt).filter(([dir]) => keep(dir)));
        return { byTask: { ...s.byTask, [id]: { ...cur, repos, requests, results, details, detailsAt, loading: false, error: null, fetchedAt: Date.now() } } };
      });
    } catch (error) {
      set(s => ({ byTask: { ...s.byTask, [id]: { ...(s.byTask[id] ?? empty()), loading: false, error: String(error) } } }));
    }
  },
  details: async (id, expected) => {
    const detail = await taskDeliveryDetails(id, expected);
    const current = get().byTask[id]?.repos.find(r => r.dir_name === expected.dir_name)?.identity;
    if (!current || changedIdentity(expected, current)) throw new Error("Repository changed. Refresh before reviewing details.");
    set(s => ({ byTask: { ...s.byTask, [id]: { ...(s.byTask[id] ?? empty()),
      details: { ...s.byTask[id]?.details, [expected.dir_name]: detail },
      detailsAt: { ...s.byTask[id]?.detailsAt, [expected.dir_name]: Date.now() } } } }));
  },
  results: (id, results) => set(s => ({ byTask: { ...s.byTask, [id]: { ...(s.byTask[id] ?? empty()), results } } })),
}));
