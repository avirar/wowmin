// Icons from the client, loaded once each from the web server
// (assets/models/icon/<key>.png, built from WOWMIN_CLIENT_DATA): a spell's
// (`spell-<id>`), a side's PvP crest (`faction-alliance`, `faction-horde`),
// the minimap POI atlas (`poi`), and the airship minimap blips
// (`vehicle-alliance`, `vehicle-horde`).

const RETRY_MS = 60_000;

export class ClientIcons {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly onLoad: () => void) {}

  // The icon once it has loaded, else null (and it starts loading).
  get(key: string): HTMLImageElement | null {
    const image = this.images.get(key);
    if (image) return image.complete && image.naturalWidth > 0 ? image : null;
    if (Date.now() - (this.failedAt.get(key) ?? -Infinity) < RETRY_MS) return null;
    const loading = new Image();
    loading.onload = () => this.onLoad();
    loading.onerror = () => {
      this.images.delete(key);
      this.failedAt.set(key, Date.now());
    };
    loading.src = `assets/models/icon/${key}.png`;
    this.images.set(key, loading);
    return null;
  }
}
