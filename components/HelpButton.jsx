import { useEffect, useRef, useState } from "react";

// The "?" in the bottom-right corner. It opens a small menu that says what each
// choice is for, then hands off to the same feedback window as the Help menu.
// While trackpad taps are off in System Settings it leads with that, since
// "why can't I feel anything?" is the likeliest question.

const ITEMS = [
  {
    type: "bug",
    label: "Report a bug",
    hint: "Something isn't working right",
    path: "M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6ZM12 20v-9M6.5 9C4.6 8.8 3 7.2 3 5.2M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  },
  {
    type: "feature",
    label: "Request a feature",
    hint: "An idea that would make it better",
    path: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  },
];

const TAPS_OFF = {
  label: "Why can't I feel taps?",
  hint: "Haptic feedback is off in Trackpad settings. Click to open them.",
  path: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 8v4M12 16h.01",
};

export default function HelpButton({ hapticsOff }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const toggleRef = useRef(null);
  const firstItemRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    firstItemRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    // Capture, so a click on the device still closes the menu.
    const onPointer = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  function choose(type) {
    setOpen(false);
    window.api.openFeedback(type);
  }

  function openTrackpadSettings() {
    setOpen(false);
    window.api.openTrackpadSettings();
  }

  const items = [
    ...(hapticsOff ? [{ ...TAPS_OFF, onClick: openTrackpadSettings }] : []),
    ...ITEMS.map((item) => ({ ...item, onClick: () => choose(item.type) })),
  ];

  return (
    <div className="help" ref={rootRef}>
      {open && (
        <div id="help-menu" className="help-menu" role="menu" aria-label="Help and feedback">
          <p className="help-menu-title">Help and feedback</p>
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={i === 0 ? firstItemRef : undefined}
              className={`help-item ${item.type ? "" : "help-item--alert"}`}
              role="menuitem"
              onClick={item.onClick}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={item.path} />
              </svg>
              <span>
                <span className="help-item-label">{item.label}</span>
                <span className="help-item-hint">{item.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <button
        ref={toggleRef}
        className={`help-toggle ${open ? "help-toggle--open" : ""}`}
        aria-label="Help and feedback"
        title="Help and feedback"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="help-menu"
        onClick={() => setOpen((o) => !o)}
      >
        ?
        {hapticsOff && <span className="help-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
