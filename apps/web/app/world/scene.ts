import type { Persona, SimEvent } from "../lib";

const HUBS = [
  { x: 190, y: 150, name: "cafe", roof: 0xa34a2d, wall: 0x7c4a2d },
  { x: 740, y: 150, name: "stage", roof: 0x5a3d9c, wall: 0x4a2d7c },
  { x: 190, y: 470, name: "park", roof: 0x2d9c5a, wall: 0x2d7c4a },
  { x: 740, y: 470, name: "market", roof: 0x9c8a3d, wall: 0x7c6a2d },
];
const TILE = 24;

export function createWorldScene(
  Phaser: any,
  personas: Persona[],
  onSelect: (p: Persona) => void
) {
  const chars = new Map<string, any>();
  const bubbles = new Map<string, any>();
  const bubbleObjs: any[] = [];
  const queue: SimEvent[] = [];
  let activeBubbles = 0;
  const MAX_BUBBLES = 4;
  const api: any = {};

  function drawTown(scene: any) {
    const g = scene.add.graphics();
    // grass tiles
    for (let y = 0; y < 600 / TILE; y++)
      for (let x = 0; x < 960 / TILE; x++) {
        g.fillStyle((x + y) % 2 ? 0x1f521f : 0x1d4a1d);
        g.fillRect(x * TILE, y * TILE, TILE, TILE);
      }
    // cobble paths
    for (const [x0, y0, w, h] of [[0, 280, 960, 48], [456, 0, 48, 600]] as const)
      for (let y = y0; y < y0 + h; y += 12)
        for (let x = x0; x < x0 + w; x += 16) {
          g.fillStyle((x / 16 + y / 12) % 2 ? 0x7a6a4e : 0x6b5b3e);
          g.fillRect(x + (y % 24 ? 4 : 0), y, 14, 10);
        }
    // buildings
    for (const h of HUBS) {
      g.fillStyle(0x000000, 0.3).fillRect(h.x - 64, h.y - 46, 128, 92);
      g.fillStyle(h.wall).fillRect(h.x - 60, h.y - 20, 120, 60);
      g.fillStyle(h.roof).fillTriangle(h.x - 70, h.y - 20, h.x + 70, h.y - 20, h.x, h.y - 56);
      g.fillStyle(0x3a2a1a).fillRect(h.x - 8, h.y + 14, 16, 26);
      g.fillStyle(0xcfe8ff);
      g.fillRect(h.x - 45, h.y - 4, 18, 14);
      g.fillRect(h.x + 27, h.y - 4, 18, 14);
      g.fillStyle(0x3a2a1a);
      g.fillRect(h.x - 36, h.y - 4, 2, 14);
      g.fillRect(h.x + 36, h.y - 4, 2, 14);
    }
    // trees + lamps
    for (const [tx, ty] of [[60, 90], [880, 90], [60, 540], [880, 540], [480, 90]] as const) {
      g.fillStyle(0x5a3d20).fillRect(tx - 3, ty, 6, 20);
      g.fillStyle(0x2f7a3f).fillCircle(tx, ty - 8, 18);
      g.fillStyle(0x3f9a4f).fillCircle(tx - 4, ty - 12, 10);
    }
    for (const [lx, ly] of [[430, 270], [530, 340], [430, 340], [530, 270]] as const) {
      g.fillStyle(0x333).fillRect(lx - 1, ly - 22, 2, 22);
      g.fillStyle(0xffe28a).fillCircle(lx, ly - 24, 4);
    }
    g.generateTexture("town", 960, 600);
    g.destroy();
    scene.add.image(480, 300, "town").setDepth(0);
    for (const h of HUBS)
      scene.add.text(h.x, h.y + 44, h.name, { fontSize: "10px", color: "#fff" })
        .setOrigin(0.5).setDepth(1);
  }

  function makeSpriteTextures(scene: any, p: Persona) {
    for (let f = 0; f < 2; f++) {
      const key = `p-${p.id}-${f}`;
      if (scene.textures.exists(key)) continue;
      const c = scene.textures.createCanvas(key, 16, 24)!;
      const ctx = c.getContext();
      const [skin, shirt, pants] = p.avatar.palette;
      ctx.fillStyle = skin; ctx.fillRect(4, 0, 8, 7);
      ctx.fillStyle = shirt; ctx.fillRect(3, 7, 10, 10);
      ctx.fillStyle = pants;
      if (f === 0) { ctx.fillRect(4, 17, 3, 7); ctx.fillRect(9, 17, 3, 7); }
      else { ctx.fillRect(3, 17, 3, 6); ctx.fillRect(10, 18, 3, 6); }
      ctx.fillStyle = "#111"; ctx.fillRect(5, 3, 2, 2); ctx.fillRect(9, 3, 2, 2);
      if (p.avatar.accessory === "hat") { ctx.fillStyle = pants; ctx.fillRect(3, 0, 10, 2); ctx.fillRect(1, 2, 14, 1); }
      if (p.avatar.accessory === "glasses") { ctx.fillStyle = "#fff"; ctx.fillRect(4, 2, 8, 3); }
      if (p.avatar.accessory === "scarf") { ctx.fillStyle = shirt; ctx.fillRect(3, 6, 10, 3); }
      if (p.avatar.accessory === "headphones") { ctx.fillStyle = "#111"; ctx.fillRect(2, 2, 2, 4); ctx.fillRect(12, 2, 2, 4); }
      c.refresh();
    }
  }

  api.say = (id: string, text: string) => {
    const ch = chars.get(id);
    if (!ch) return;
    if (bubbles.has(id)) {
      queue.push({ personaId: id, ts: "", kind: "post", text });
      return;
    }
    if (activeBubbles >= MAX_BUBBLES) {
      queue.push({ personaId: id, ts: "", kind: "post", text });
      return;
    }
    showBubble(ch, text);
  };

  function showBubble(ch: any, text: string) {
    activeBubbles++;
    const id = ch.persona.id;
    const w = Math.min(140, Math.max(60, text.length * 5));
    const x = Phaser.Math.Clamp(ch.x, w / 2 + 6, 960 - w / 2 - 6);
    const y = Math.max(30, ch.y - 34);
    const b = ch.scene.add
      .text(x, Math.max(30, ch.y - 34), text.slice(0, 90), {
        fontSize: "9px", color: "#111", backgroundColor: "#fffffff0",
        padding: { x: 4, y: 2 }, wordWrap: { width: w },
      })
      .setOrigin(0.5, 1).setDepth(20).setAlpha(0);
    bubbles.set(id, b);
    bubbleObjs.push(b);
    b.speaker = ch;
    ch.scene.tweens.add({ targets: b, alpha: 1, duration: 200 });
    ch.scene.time.delayedCall(3000, () => {
      ch.scene.tweens.add({
        targets: b, alpha: 0, duration: 400,
        onComplete: () => {
          b.destroy(); bubbles.delete(id);
          bubbleObjs.splice(bubbleObjs.indexOf(b), 1);
          activeBubbles--;
          const next = queue.shift();
          if (next) api.say(next.personaId, next.text);
        },
      });
    });
  }

  api.walkTo = (id: string, targetId: string) => {
    const ch = chars.get(id), t = chars.get(targetId);
    if (!ch || !t) return;
    moveTo(ch, t.x + 20, t.y);
  };

  function moveTo(ch: any, x: number, y: number) {
    ch.moving = true;
    ch.flipX = x < ch.x;
    ch.scene.tweens.add({
      targets: ch, x, y, duration: Math.max(800, Phaser.Math.Distance.Between(ch.x, ch.y, x, y) * 8),
      onComplete: () => { ch.moving = false; ch.setTexture(`p-${ch.persona.id}-0`); },
    });
  }

  api.addPersona = (p: Persona, hubIdx: number) => {
    if (chars.has(p.id)) return;
    const scene = chars.values().next().value?.scene;
    if (!scene) return;
    spawn(scene, p, hubIdx ?? chars.size);
    const s = chars.get(p.id);
    const star = scene.add.text(s.x, s.y - 40, "NEW TWIN ✦", {
      fontSize: "10px", color: "#ffe066",
    }).setOrigin(0.5).setDepth(25);
    scene.tweens.add({ targets: star, y: s.y - 60, alpha: 0, duration: 2500, onComplete: () => star.destroy() });
  };

  function spawn(scene: any, p: Persona, i: number) {
    makeSpriteTextures(scene, p);
    const h = HUBS[i % HUBS.length];
    const s = scene.add
      .image(h.x + ((i * 26) % 60) - 30, h.y + 34 + (i % 2) * 14, `p-${p.id}-0`)
      .setScale(2).setDepth(5).setInteractive();
    s.persona = p;
    s.moving = false;
    s.animTick = 0;
    s.on("pointerdown", () => onSelect(p));
    const tag = scene.add
      .text(s.x, s.y + 30, p.name.split(" ")[0], {
        fontSize: "9px", color: "#fff", backgroundColor: "#000000aa", padding: { x: 3, y: 1 },
      })
      .setOrigin(0.5).setDepth(5);
    scene.events.on("update", () => {
      tag.setPosition(s.x, s.y + 30);
      if (s.moving) {
        s.animTick = (s.animTick + 1) % 16;
        s.setTexture(`p-${p.id}-${s.animTick < 8 ? 0 : 1}`);
      }
    });
    chars.set(p.id, s);
    scene.time.addEvent({
      delay: 5000 + Math.random() * 4000,
      loop: true,
      callback: () => {
        const h2 = HUBS[Math.floor(Math.random() * HUBS.length)];
        moveTo(s, h2.x + Math.random() * 70 - 35, h2.y + 24 + Math.random() * 20);
      },
    });
  }

  class World extends Phaser.Scene {
    update() {
      for (const b of bubbleObjs) {
        b.setPosition(Phaser.Math.Clamp(b.speaker.x, b.width / 2 + 6, 960 - b.width / 2 - 6),
          Math.max(b.height + 6, b.speaker.y - 34));
      }
      for (let i = 0; i < bubbleObjs.length; i++)
        for (let j = i + 1; j < bubbleObjs.length; j++) {
          const a = bubbleObjs[i], c = bubbleObjs[j];
          const r1 = a.getBounds(), r2 = c.getBounds();
          if (Phaser.Geom.Rectangle.Overlaps(r1, r2))
            c.y = Math.max(c.height + 6, r1.y - c.height - 4);
        }
    }
    create() {
      drawTown(this);
      personas.forEach((p, i) => spawn(this, p, i));
      (this as any).api = api;
    }
  }
  return new World();
}
