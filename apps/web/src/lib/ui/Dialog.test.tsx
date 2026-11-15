import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
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

  it("shows toasts inside the open dialog, reachable with Tab and dismissable from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Nested />
      </>,
    );
    // Without a dialog, toasts float over the window.
    expect(document.querySelector("[data-toaster]")?.getAttribute("data-toaster")).toBe("window");

    await user.click(screen.getByRole("button", { name: "Open outer" }));
    act(() => {
      toastStore.show("Can't reach the server.", "error");
    });
    const dialog = screen.getByRole("dialog", { name: "Outer" });
    const alert = screen.getByRole("alert");
    // Rendered in the dialog's own layout (not floating over its actions) and not inert.
    expect(dialog.contains(alert)).toBe(true);
    expect(alert.closest("[data-toaster]")?.getAttribute("data-toaster")).toBe("dialog");
    expect(alert.closest("[inert]")).toBeNull();
    expect(alert.textContent).toContain("Can't reach the server.");

    // The focus trap includes the dismiss button.
    const dismiss = within(alert).getByRole("button", { name: "Dismiss notification" });
    for (let i = 0; i < 5 && document.activeElement !== dismiss; i++) await user.tab();
    expect(document.activeElement).toBe(dismiss);
    await user.keyboard("{Enter}");
    expect(toastStore.getSnapshot()).toEqual([]);
    // Focus stays in the dialog, which is still open.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Closing the dialog moves the Toaster back to the window.
    await user.keyboard("{Escape}");
    expect(document.querySelector("[data-toaster]")?.getAttribute("data-toaster")).toBe("window");
  });

  it("keeps the page usable when dialogs close in any order", async () => {
    // Lets the test close A while B is on top, as an async event (a timeout, a server push) might.
    const control: { closeA?: () => void } = {};
    function Siblings() {
      const [a, setA] = useState(false);
      const [b, setB] = useState(false);
      useEffect(() => {
        control.closeA = () => setA(false);
      }, []);
      return (
        <>
          <main tabIndex={-1}>
            <Button onClick={() => setA(true)}>Open A</Button>
          </main>
          <Dialog open={a} onClose={() => setA(false)} title="A">
            <Button onClick={() => setB(true)}>Open B</Button>
          </Dialog>
          <Dialog open={b} onClose={() => setB(false)} title="B">
            <Button>B action</Button>
          </Dialog>
        </>
      );
    }
    const user = userEvent.setup();
    const { container } = render(<Siblings />);
    await user.click(screen.getByRole("button", { name: "Open A" }));
    await user.click(screen.getByRole("button", { name: "Open B" }));
    act(() => control.closeA?.());

    // A closed underneath B: the page is still inert and B keeps focus.
    expect(screen.queryByRole("dialog", { name: "A" })).toBeNull();
    const b = screen.getByRole("dialog", { name: "B" });
    expect(container.hasAttribute("inert")).toBe(true);
    expect(b.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  it("leaves elements that were inert before the first dialog inert afterwards", async () => {
    const user = userEvent.setup();
    const outside = document.createElement("div");
    outside.setAttribute("inert", "");
    document.body.appendChild(outside);
    render(<Nested />);
    await user.click(screen.getByRole("button", { name: "Open outer" }));
    await user.keyboard("{Escape}");
    expect(outside.hasAttribute("inert")).toBe(true);
    outside.remove();
  });
  it("keeps the same live regions and toasts when a dialog opens and closes", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Nested />
      </>,
    );
    act(() => {
      toastStore.show("First problem.", "error");
    });
    const alert = screen.getByRole("alert");
    const status = screen.getByRole("status");
    const toast = alert.querySelector("[data-toast]");

    await user.click(screen.getByRole("button", { name: "Open outer" }));
    // Moved into the dialog, not re-created: screen readers have nothing new to announce.
    expect(screen.getByRole("dialog", { name: "Outer" }).contains(alert)).toBe(true);
    expect(screen.getByRole("alert")).toBe(alert);
    expect(screen.getByRole("status")).toBe(status);
    expect(alert.querySelector("[data-toast]")).toBe(toast);

    // A toast raised while the dialog is open lands in the same region.
    act(() => {
      toastStore.show("Second problem.", "error");
    });
    expect(alert.querySelectorAll("[data-toast]")).toHaveLength(2);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert")).toBe(alert);
    expect(alert.querySelector("[data-toast]")).toBe(toast);
    expect(alert.querySelectorAll("[data-toast]")).toHaveLength(2);
    expect(alert.closest("[inert]")).toBeNull();
    expect(alert.closest("[data-toaster]")?.getAttribute("data-toaster")).toBe("window");
  });

  it("moves focus to the next toast after a dismissal, then to the dialog", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toaster />
        <Nested />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open outer" }));
    act(() => {
      toastStore.show("One.", "error");
      toastStore.show("Two.", "error");
    });
    const dialog = screen.getByRole("dialog", { name: "Outer" });
    const [first, second] = within(dialog).getAllByRole("button", { name: "Dismiss notification" });
    first!.focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(second);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(dialog);
  });

  it("makes elements added to the page while a dialog is open inert too", async () => {
    const user = userEvent.setup();
    render(<Nested />);
    await user.click(screen.getByRole("button", { name: "Open outer" }));
    const late = document.createElement("div");
    document.body.appendChild(late);
    await act(() => Promise.resolve()); // MutationObserver callbacks run as microtasks
    expect(late.hasAttribute("inert")).toBe(true);

    await user.keyboard("{Escape}");
    expect(late.hasAttribute("inert")).toBe(false);
    late.remove();
  });
});
