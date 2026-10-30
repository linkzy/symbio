import { useEffect, useState } from "react";
import { ArrowUp, Folder, HardDrive, Home as HomeIcon } from "lucide-react";
import { api } from "./api";

type Listing = Awaited<ReturnType<typeof api.listDirs>>;

/**
 * Pick a folder on the computer running Symbio, inside the page. Used through remote access,
 * where the native dialog would open on that computer's screen instead of yours.
 */
export function FolderBrowser({ start, onPick, onCancel }: { start?: string; onPick: (path: string) => void; onCancel: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async (path?: string) => {
    setLoading(true);
    try {
      setListing(await api.listDirs(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void open(start || undefined).then(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const join = (dir: string, name: string) => (dir.endsWith(listing!.sep) ? dir + name : dir + listing!.sep + name);

  return (
    <div className="folder-browser">
      <div className="folder-browser-head">
        <button className="btn ghost icon sm" title="Up one level" disabled={!listing?.parent || loading} onClick={() => open(listing!.parent!)}>
          <ArrowUp size={14} />
        </button>
        <code className="folder-browser-path ellipsis" title={listing?.path}>
          {listing?.path ?? "…"}
        </code>
      </div>
      <div className="folder-browser-places">
        {listing && (
          <button className="btn ghost sm" onClick={() => open(listing.home)}>
            <HomeIcon size={13} />
            Home
          </button>
        )}
        {listing?.roots.map((r) => (
          <button key={r} className="btn ghost sm" onClick={() => open(r)}>
            <HardDrive size={13} />
            {r}
          </button>
        ))}
      </div>
      <div className="folder-browser-list">
        {error && <div className="error">{error}</div>}
        {listing?.dirs.length === 0 && !error && <div className="section-empty">No folders here.</div>}
        {listing?.dirs.map((d) => (
          <button key={d} className="folder-browser-item" disabled={loading} onClick={() => open(join(listing.path, d))}>
            <Folder size={14} />
            <span className="ellipsis">{d}</span>
          </button>
        ))}
      </div>
      <div className="folder-browser-foot">
        <span className="small subtle">Open a folder, then choose it. To start somewhere new, choose its parent and add the new folder's name to the path.</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary sm" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
          Choose this folder
        </button>
      </div>
    </div>
  );
}
