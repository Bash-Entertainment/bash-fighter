// Rasterizes a character's real match silhouette (idle pose, facing right)
// to a small PNG data URL, for the character-select screen. Deliberately
// reuses drawSilhouetteForCharacter -- the exact function FighterSprite
// calls during a live match -- so the select screen can never drift from
// what a fighter actually looks like in play.
import { Application, Graphics } from 'pixi.js';
import { NEUTRAL_POSE } from './fighter-pose.ts';
import { drawSilhouetteForCharacter } from './silhouette-dispatch.ts';

// Cache the *promise*, not just the resolved Application: the roster grid
// (character-select.ts) calls renderCharacterIcon once per character in a
// synchronous loop, with no await between calls. The old code checked
// `if (sharedApp) return sharedApp;` -- a plain synchronous read -- and
// then `await app.init(...)`. Every one of those calls sees `sharedApp`
// still null (the first call's init hasn't resolved yet) and constructs
// its *own* `new Application()`, each opening a real WebGL context. With
// an 8-character roster that is 8 live contexts spent on invisible
// silhouette icons before a player has clicked anything -- on top of
// whatever the start screen's attract-mode match and, later, the real
// match renderer need. A browser only grants a page a dozen or so; this
// alone was enough to exhaust them within one or two page loads and is
// almost certainly what the six-to-eight repeated PixiJS transparency
// warnings and the "WebGL context was lost" seen on production were.
// Caching the in-flight promise makes every concurrent caller await the
// same single construction instead of racing to start their own.
let sharedAppPromise: Promise<Application> | null = null;

async function getSharedApp(size: number): Promise<Application> {
  if (!sharedAppPromise) {
    sharedAppPromise = (async () => {
      const app = new Application();
      // Pixi's BackgroundSystem.init() applies `background` *before*
      // `backgroundAlpha` (see its source), so passing the string
      // `background: 'transparent'` always warns "Cannot set a
      // transparent background on an opaque canvas" -- the alpha isn't
      // zeroed out yet when the colour setter runs its opacity check, no
      // matter what backgroundAlpha you also pass. This was firing on
      // every single icon init and is one of the two symptoms reported
      // live. Passing no `background` (default opaque black, alpha
      // already 1, so the setter's opacity check never trips) and relying
      // solely on `backgroundAlpha: 0` gets the same transparent PNG
      // output with no warning.
      await app.init({
        width: size,
        height: size,
        backgroundAlpha: 0,
        antialias: true,
        preference: 'webgl',
      });
      return app;
    })();
  }
  return sharedAppPromise;
}

/**
 * Renders one character's idle silhouette into a `size`x`size` transparent
 * PNG data URL, scaled and centred to fit with a small margin. Safe to
 * call for every roster entry up front (e.g. once when the select screen
 * mounts) -- it reuses one small offscreen renderer rather than spinning
 * up a WebGL context per card.
 */
export async function renderCharacterIcon(characterName: string | undefined, tint: number, size = 96): Promise<string> {
  const app = await getSharedApp(size);
  const g = new Graphics();
  drawSilhouetteForCharacter(g, tint, 1, NEUTRAL_POSE, characterName);

  const bounds = g.getLocalBounds();
  const margin = size * 0.12;
  const availableW = size - margin * 2;
  const availableH = size - margin * 2;
  const scale = bounds.width > 0 && bounds.height > 0 ? Math.min(availableW / bounds.width, availableH / bounds.height) : 1;

  g.scale.set(scale);
  // Centre the scaled bounds within the icon square.
  g.position.set(size / 2 - (bounds.x + bounds.width / 2) * scale, size / 2 - (bounds.y + bounds.height / 2) * scale);

  app.stage.removeChildren();
  app.stage.addChild(g);
  app.renderer.render(app.stage);
  const url = await app.renderer.extract.base64(app.stage);
  g.destroy();
  return url;
}
