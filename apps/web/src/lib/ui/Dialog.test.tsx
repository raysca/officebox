import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Toaster } from "./Toaster";
import { toastStore } from "./toast-store";

function Nested() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <main tabIndex={-1}>
      <Button onClick={() => setOuter(true)}>Open outer</Button>
      <Dialog open={outer} onClose={() => setOuter(false)} title="Outer">
        <Button onClick={() => setInner(true)}>Open inner</Button>
        <Dialog open={inner} onClose={() => setInner(false)} title="Inner">
          <Button>Inner action</Button>
        </Dialog>
      </Dialog>
    </main>
  );
}

describe("Dialog", () => {
  it("closes nested dialogs one Esc at a time, returning focus to each opener", async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole("button", { name: "Open outer" }));
    await user.click(screen.getByRole("button", { name: "Open inner" }));
    const inner = screen.getByRole("dialog", { name: "Inner" });
    expect(inner.contains(document.activeElement)).toBe(true);

    // Tab stays in the inner dialog only.
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(inner.contains(document.activeElement)).toBe(true);
    }

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open inner" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open outer" }));
  });

  it("focuses initialFocusRef when given", async () => {
    function WithInitialFocus() {
      const ref = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Confirm" initialFocusRef={ref}>
            <Button>First</Button>
            <Button ref={ref}>Preferred</Button>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    render(<WithInitialFocus />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preferred" }));
  });

  it("sends focus to the main content when the opener was removed while open", async () => {
    function RemovesOpener() {
      const [open, setOpen] = useState(false);
      const [showOpener, setShowOpener] = useState(true);
      return (
        <main tabIndex={-1}>
          {showOpener ? <Button onClick={() => setOpen(true)}>Open</Button> : null}
          <Dialog open={open} onClose={() => setOpen(false)} title="Remove">
            <Button onClick={() => setShowOpener(false)}>Remove opener</Button>
          </Dialog>
        </main>
      );
    }
    const user = userEvent.setup();
    render(<RemovesOpener />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Remove opener" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("keeps toasts outside the inert page, so they're announced and can be dismissed", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Nested />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open outer" }));
    act(() => {
      toastStore.show("Can't reach the server.", "error");
    });
    const alert = screen.getByRole("alert");
    expect(alert.closest("[inert]")).toBeNull();
    expect(alert.textContent).toContain("Can't reach the server.");

    await user.click(within(alert).getByRole("button", { name: "Dismiss notification" }));
    expect(toastStore.getSnapshot()).toEqual([]);
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeDefined();
  });
});
