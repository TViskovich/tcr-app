import { useState, useRef, useEffect, useCallback } from "react";
import { motion } from "motion/react";
import { Home, Globe, Grid3X3, MessageSquare, FolderOpen, Plus } from "lucide-react";
import { ImageWithFallback } from "@/app/components/figma/ImageWithFallback";
import heroImage from "@/imports/Hero_image.png";
import logoImage from "@/imports/cachecase-logo-w.png";
import emblemImage from "@/imports/Certified-cachecase.png";
import profileImage from "@/imports/moebryan_profile_image.png";

// ─── Holographic Hero ────────────────────────────────────────────────────────

function HoloHero({ mouseX, mouseY }: { mouseX: number; mouseY: number }) {
  const hue = mouseX * 300 + 20;
  const angle = Math.atan2(mouseY - 0.5, mouseX - 0.5) * (180 / Math.PI);
  const intensity = Math.hypot(mouseX - 0.5, mouseY - 0.5) * 2;

  const holoGradient = `linear-gradient(
    ${angle + 45}deg,
    hsla(${hue}, 100%, 65%, ${0.35 + intensity * 0.25}),
    hsla(${hue + 90}, 100%, 60%, ${0.2 + intensity * 0.2}),
    hsla(${hue + 180}, 100%, 65%, ${0.35 + intensity * 0.25}),
    hsla(${hue + 270}, 100%, 60%, ${0.2 + intensity * 0.2})
  )`;

  const shimmerGradient = `conic-gradient(
    from ${angle * 2}deg at ${mouseX * 100}% ${mouseY * 100}%,
    hsla(${hue}, 100%, 70%, 0.15),
    hsla(${hue + 60}, 100%, 70%, 0.25),
    hsla(${hue + 120}, 100%, 70%, 0.15),
    hsla(${hue + 180}, 100%, 70%, 0.25),
    hsla(${hue + 240}, 100%, 70%, 0.15),
    hsla(${hue + 300}, 100%, 70%, 0.25),
    hsla(${hue + 360}, 100%, 70%, 0.15)
  )`;

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url(${heroImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: "blur(5px) saturate(2.0) brightness(0.75)",
          transform: "scale(1.08)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 70% at 50% 50%, transparent 30%, rgba(0,0,0,0.55) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{ background: holoGradient, mixBlendMode: "color", transition: "background 0.08s ease-out" }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: shimmerGradient,
          mixBlendMode: "overlay",
          opacity: 0.6 + intensity * 0.3,
          transition: "background 0.1s ease-out",
        }}
      />
      <div
        className="absolute pointer-events-none"
        style={{
          width: 200, height: 200, borderRadius: "50%",
          left: `calc(${mouseX * 100}% - 100px)`,
          top: `calc(${mouseY * 100}% - 100px)`,
          background: `radial-gradient(circle, hsla(${hue + 60}, 100%, 95%, 0.18) 0%, transparent 70%)`,
          transition: "left 0.15s ease-out, top 0.15s ease-out",
        }}
      />
      {/* Circle portrait — bottom-aligned, sits just above THE RULER title */}
      <div className="absolute inset-x-0 flex justify-center" style={{ bottom: 88 }}>
        <div className="rounded-full overflow-hidden" style={{ width: "100%", aspectRatio: "1 / 1" }}>
          <ImageWithFallback
            src={heroImage}
            alt="Hero portrait"
            className="w-full h-full object-cover object-top"
          />
        </div>
      </div>
      {/* Gradient — starts low so image is visible for ~65% of screen */}
      <div
        className="absolute inset-x-0 bottom-0 pointer-events-none"
        style={{ height: "30%", background: "linear-gradient(to bottom, transparent 0%, #0a0a0f 100%)" }}
      />
    </div>
  );
}

// ─── Wheel ───────────────────────────────────────────────────────────────────
// Order: About | CacheCase (default center) | Art | Pokémon | Basketball | Football
// Infinite scroll — wraps in both directions.

const WHEEL_ITEMS = [
  { id: "post",        label: "Posts",       isLogo: false },
  { id: "cachecase",   label: "",            isLogo: true  },  // index 1 → centered on load
  { id: "collection",  label: "Collections", isLogo: false },
  { id: "transfers",   label: "Transfers",   isLogo: false },
  { id: "bookmarked",  label: "Bookmarked",  isLogo: false },
];

const ITEM_W   = 108;
const ITEM_GAP = 14;
const SLOT     = ITEM_W + ITEM_GAP;
const MAX_DIP  = 12;
const N        = WHEEL_ITEMS.length;

// Map any virtual position to a real item (wraps infinitely)
const itemAt = (vp: number) => WHEEL_ITEMS[((vp % N) + N) % N];

function Wheel({ hue, onCenterTap }: { hue: number; onCenterTap?: (id: string) => void }) {
  const [offset, setOffset]     = useState(-SLOT);
  const [settling, setSettling] = useState(false);

  const isDragging  = useRef(false);
  const startX      = useRef(0);
  const startOffset = useRef(0);
  const dragDist    = useRef(0);

  const snapNearest = (raw: number) => {
    const vp = Math.round(-raw / SLOT);
    setSettling(true);
    setOffset(-vp * SLOT);
    setTimeout(() => setSettling(false), 350);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    dragDist.current   = 0;
    setSettling(false);
    startX.current      = e.clientX;
    startOffset.current = offset;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - startX.current;
    dragDist.current = Math.abs(dx);
    setOffset(startOffset.current + dx);
  };

  const onPointerUp = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    snapNearest(offset);
    // Tap = barely moved → fire callback with centred item id
    if (dragDist.current < 6 && onCenterTap) {
      const vp = Math.round(-offset / SLOT);
      onCenterTap(itemAt(vp).id);
    }
  };

  // Fractional virtual centre (drives continuous visual effects)
  const fCenter  = -offset / SLOT;
  const centerVP = Math.round(fCenter);

  // Actual item index currently centred (for dot highlight)
  const centerItemIdx = ((centerVP % N) + N) % N;

  // Render a window of 9 virtual positions around the current centre
  const virtualPositions = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(d => centerVP + d);

  return (
    <div className="w-full flex flex-col items-center gap-3 select-none">
      <style>{`@keyframes holo-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>

      {/* Track */}
      <div
        className="relative w-full"
        style={{ height: 64, overflow: "hidden", touchAction: "none",
                 cursor: isDragging.current ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {virtualPositions.map((vp) => {
          const item  = itemAt(vp);
          const dist  = Math.abs(vp - fCenter);
          const scale   = Math.max(0.76, 1 - dist * 0.1);
          const opacity = Math.max(0.0,  1 - dist * 0.38);
          const yDip    = Math.min(dist * dist * MAX_DIP, MAX_DIP * 4);
          const isC     = vp === centerVP;

          // x position: centre of this item relative to container centre
          const xFromCenter = vp * SLOT + offset;

          const pill = (
            <div
              className="flex items-center justify-center rounded-xl"
              style={{
                width: ITEM_W,
                height: isC ? 44 : 38,
                background: isC ? "rgba(16,16,26,0.92)" : "rgba(255,255,255,0.05)",
                backdropFilter: "blur(10px)",
                border: isC ? "none" : "1px solid rgba(255,255,255,0.09)",
                pointerEvents: "none",
              }}
            >
              {item.isLogo ? (
                <ImageWithFallback
                  src={logoImage}
                  alt="CacheCase"
                  className="object-contain"
                  style={{ width: 76, height: 30 }}
                />
              ) : (
                <span style={{
                  fontFamily: "'Barlow Condensed', sans-serif",
                  fontWeight: 600,
                  fontSize: isC ? 13 : 11,
                  letterSpacing: "0.08em",
                  textTransform: "lowercase",
                  color: isC ? "#fff" : "rgba(255,255,255,0.7)",
                }}>
                  {item.label}
                </span>
              )}
            </div>
          );

          return (
            <div
              key={vp}
              style={{
                position: "absolute",
                top: 6,
                left: `calc(50% + ${xFromCenter - ITEM_W / 2}px)`,
                transform: `scale(${scale}) translateY(${yDip}px)`,
                transformOrigin: "center top",
                opacity,
                transition: settling
                  ? "left 0.32s cubic-bezier(0.25,0.46,0.45,0.94), transform 0.32s ease, opacity 0.32s ease"
                  : "none",
                willChange: "left, transform, opacity",
              }}
            >
              {isC ? (
                <div style={{ position: "relative", borderRadius: 12, padding: "1.5px", overflow: "hidden" }}>
                  <div style={{
                    position: "absolute",
                    inset: -44,
                    background: `conic-gradient(
                      hsl(${hue},55%,80%),
                      hsl(${hue+50},50%,82%),
                      hsl(${hue+110},55%,84%),
                      hsl(${hue+170},50%,82%),
                      hsl(${hue+230},55%,80%),
                      hsl(${hue+290},50%,82%),
                      hsl(${hue},55%,80%)
                    )`,
                    animation: "holo-spin 2.4s linear infinite",
                  }} />
                  <div style={{ position: "relative", zIndex: 1 }}>{pill}</div>
                </div>
              ) : pill}
            </div>
          );
        })}
      </div>

      {/* Dots — one per real item, highlight the centred one */}
      <div className="flex gap-1.5 mb-6">
        {WHEEL_ITEMS.map((_, i) => (
          <div key={i} className="rounded-full transition-all duration-300" style={{
            width: i === centerItemIdx ? 16 : 4,
            height: 4,
            background: i === centerItemIdx
              ? `linear-gradient(90deg,hsl(${hue},100%,70%),hsl(${hue+120},100%,70%))`
              : "rgba(255,255,255,0.18)",
          }} />
        ))}
      </div>
    </div>
  );
}

// ─── Nav ─────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { icon: Home,          label: "Home"     },
  { icon: Globe,         label: "Explore"  },
  { icon: Grid3X3,       label: "Grid"     },
  { icon: MessageSquare, label: "Messages" },
  { icon: FolderOpen,    label: "Files"    },
];

// ─── Profile Banner ──────────────────────────────────────────────────────────

const stat = (label: string, value: string) => ({ label, value });
const COLLECTION_STATS = [
  stat("Vault Total",    "142 Assets"),
  stat("Authenticated",  "19 Graded"),
  stat("Transferred",    "102 Items"),
];

function ProfileBanner({ hue }: { hue: number }) {
  const divider: React.CSSProperties = {
    width: 1, alignSelf: "stretch", background: "rgba(255,255,255,0.08)", flexShrink: 0,
  };

  return (
    <div style={{
      margin: "0 3px 3px",
      borderRadius: 10,
      background: "rgba(12,12,20,0.97)",
      border: "1px solid rgba(255,255,255,0.11)",
      overflow: "hidden",
    }}>
      {/* Three pillars */}
      <div style={{ display: "flex", alignItems: "flex-start" }}>

        {/* PROFILE */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 4px 6px", gap: 3 }}>
          <div style={{
            width: 44, height: 44, borderRadius: "50%", overflow: "hidden",
            border: "1.5px solid rgba(255,255,255,0.18)", flexShrink: 0,
          }}>
            <ImageWithFallback src={profileImage} alt="moebryan" className="w-full h-full object-cover object-top" />
          </div>
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 11, color: "#fff", textAlign: "center", letterSpacing: "0.04em", lineHeight: 1.2, marginTop: 2 }}>
            THE RULER
          </span>
          <span style={{ fontFamily: "'Barlow', sans-serif", fontSize: 9, color: "rgba(255,255,255,0.38)", textAlign: "center" }}>
            @moebryan
          </span>
        </div>

        <div style={divider} />

        {/* COLLECTION */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 4px 6px", gap: 1 }}>
          {COLLECTION_STATS.map(({ label, value }, i) => (
            <div key={label} style={{ textAlign: "center", marginTop: i > 0 ? 2 : 0 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 7, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)" }}>
                {label}
              </div>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 11, color: "#fff", lineHeight: 1.15 }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        <div style={divider} />

        {/* ACCOUNT */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 4px 6px", gap: 3 }}>
          <div style={{ width: 44, height: 44, flexShrink: 0 }}>
            <ImageWithFallback src={emblemImage} alt="CCA emblem" className="w-full h-full object-contain" />
          </div>
          <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 11, textAlign: "center", marginTop: 2 }}>
            <span style={{ color: "#fff" }}>CCA </span>
            <span style={{ color: `hsl(${hue + 60}, 65%, 72%)` }}>#1</span>
          </span>
        </div>

      </div>
    </div>
  );
}

// ─── Image Grid ──────────────────────────────────────────────────────────────

function ImageGrid() {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gridTemplateRows: "repeat(3, 1fr)",
      gap: 2,
      padding: "2px 3px 3px",
      flex: 1,
      height: "100%",
    }}>
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px dashed rgba(255,255,255,0.1)",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            transition: "background 0.15s",
          }}
          onPointerEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
          onPointerLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
        >
          <Plus size={18} color="rgba(255,255,255,0.2)" strokeWidth={1.5} />
        </div>
      ))}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeNav, setActiveNav] = useState(2);
  const [mouse, setMouse] = useState({ x: 0.5, y: 0.3 });
  const phoneRef  = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef   = useRef<HTMLDivElement>(null);
  const rafRef    = useRef<number>(0);
  const targetMouse = useRef({ x: 0.5, y: 0.3 });

  const scrollToGrid = useCallback(() => {
    gridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      setMouse((prev) => ({
        x: prev.x + (targetMouse.current.x - prev.x) * 0.08,
        y: prev.y + (targetMouse.current.y - prev.y) * 0.08,
      }));
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!phoneRef.current) return;
    const rect = phoneRef.current.getBoundingClientRect();
    targetMouse.current = {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  useEffect(() => {
    const handler = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      targetMouse.current = {
        x: Math.max(0, Math.min(1, (e.gamma + 45) / 90)),
        y: Math.max(0, Math.min(1, (e.beta + 45) / 90)),
      };
    };
    window.addEventListener("deviceorientation", handler);
    return () => window.removeEventListener("deviceorientation", handler);
  }, []);

  const hue = mouse.x * 300 + 20;

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0a0a0f]">
      <style>{`#phone-scroll::-webkit-scrollbar{display:none}`}</style>
      <div
        ref={phoneRef}
        onMouseMove={handleMouseMove}
        className="relative flex flex-col overflow-hidden rounded-[2.5rem]"
        style={{
          width: "min(390px, 100vw)",
          height: "min(844px, 100dvh)",
          background: "#0a0a0f",
          boxShadow: "0 0 0 2px #222230, 0 32px 80px rgba(0,0,0,0.9), 0 0 60px rgba(180,100,255,0.12)",
        }}
      >
        {/* ── Scrollable content ── */}
        <div
          id="phone-scroll"
          ref={scrollRef}
          className="flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "none", overscrollBehavior: "contain" }}
        >
          {/* Hero — fixed height so it acts as "above the fold" */}
          <div className="relative flex-shrink-0" style={{ height: 548 }}>
            <HoloHero mouseX={mouse.x} mouseY={mouse.y} />
            <div
              className="absolute inset-x-0 bottom-4 flex flex-col items-center gap-1 pointer-events-none"
              style={{ zIndex: 10 }}
            >
              <h1 className="text-white leading-none" style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontWeight: 700, fontSize: 42, letterSpacing: "0.08em",
                textTransform: "uppercase", textShadow: "0 2px 24px rgba(0,0,0,0.9)",
              }}>
                THE RULER
              </h1>
              <p style={{
                fontFamily: "'Barlow', sans-serif", fontSize: 13,
                letterSpacing: "0.06em", color: "rgba(255,255,255,0.6)",
                textShadow: "0 1px 12px rgba(0,0,0,0.9)",
              }}>
                @moebryan
              </p>
            </div>
          </div>

          {/* Follow / Message buttons */}
          <div className="flex gap-2 px-8" style={{ paddingTop: 8, paddingBottom: 2 }}>
            <button style={{
              flex: 1, padding: "5px 0", borderRadius: 20,
              background: "#e8181a", border: "none", cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
              fontSize: 12, letterSpacing: "0.1em", color: "#fff",
            }}>
              FOLLOW
            </button>
            <button style={{
              flex: 1, padding: "5px 0", borderRadius: 20,
              background: "transparent", border: "1px solid rgba(255,255,255,0.3)", cursor: "pointer",
              fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700,
              fontSize: 12, letterSpacing: "0.1em", color: "#fff",
            }}>
              MESSAGE
            </button>
          </div>

          {/* Bio + followers */}
          <div className="flex flex-col items-center px-5" style={{ gap: 4, paddingTop: 4, paddingBottom: 8 }}>
            <div className="text-center">
              <p style={{ fontFamily: "'Barlow', sans-serif", fontSize: 12, color: "rgba(255,255,255,0.35)" }}>
                Collecting is what I do.
              </p>
              <a href="https://moebryan.com" target="_blank" rel="noopener noreferrer" style={{
                fontFamily: "'Barlow', sans-serif", fontSize: 12,
                color: `hsl(${hue + 60}, 80%, 72%)`, textDecoration: "none", letterSpacing: "0.02em",
              }}>
                moebryan.com
              </a>
            </div>

            <div className="flex items-center gap-6">
              <button className="flex flex-col items-center gap-0.5 hover:opacity-80 transition-opacity" aria-label="Followers">
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, lineHeight: 1, color: "#fff" }}>30k</span>
                <span style={{ fontFamily: "'Barlow', sans-serif", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)" }}>Followers</span>
              </button>
              <div style={{ width: 1, height: 28, background: "rgba(255,255,255,0.1)" }} />
              <button className="flex flex-col items-center gap-0.5 hover:opacity-80 transition-opacity" aria-label="Following">
                <span style={{ fontFamily: "'Barlow Condensed', sans-serif", fontSize: 20, fontWeight: 700, lineHeight: 1, color: "#fff" }}>1.5k</span>
                <span style={{ fontFamily: "'Barlow', sans-serif", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.35)" }}>Following</span>
              </button>
            </div>
          </div>

          {/* ── Sticky block: wheel + banner always pinned below camera ── */}
          <div
            className="sticky z-20"
            style={{
              top: 42,
              background: "rgba(10,10,15,0.96)",
              backdropFilter: "blur(20px)",
              paddingTop: 10,
              paddingBottom: 0,
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            <Wheel hue={hue} onCenterTap={(id) => { if (id === "cachecase") scrollToGrid(); }} />
            <ProfileBanner hue={hue} />
          </div>

          {/* ── Image grid — fills exactly to nav bar, no overflow ── */}
          <div ref={gridRef} style={{ display: "flex", flexDirection: "column", height: "calc(min(844px, 100dvh) - 56px - 42px - 220px)" }}>
            <ImageGrid />
          </div>
        </div>

        {/* ── Bottom Nav — always visible ── */}
        <div
          className="flex-shrink-0 flex items-center justify-around px-2 py-3"
          style={{
            background: "rgba(12,12,18,0.97)",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            backdropFilter: "blur(20px)",
          }}
        >
          {NAV_ITEMS.map((item, i) => {
            const Icon = item.icon;
            const isActive = activeNav === i;
            return (
              <button key={i} onClick={() => setActiveNav(i)}
                className="flex items-center justify-center"
                style={{ minWidth: 48, minHeight: 48 }} aria-label={item.label}
              >
                <div className="relative flex items-center justify-center">
                  {isActive && (
                    <motion.div layoutId="nav-glow" className="absolute rounded-full" style={{
                      width: 36, height: 36,
                      background: `radial-gradient(circle, hsla(${hue}, 80%, 70%, 0.35) 0%, transparent 70%)`,
                    }} />
                  )}
                  <Icon size={22} strokeWidth={isActive ? 2.5 : 1.5}
                    color={isActive ? `hsl(${hue + 60}, 80%, 75%)` : "rgba(255,255,255,0.3)"} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
