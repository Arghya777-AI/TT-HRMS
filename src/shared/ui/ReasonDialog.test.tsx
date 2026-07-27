/**
 * ReasonDialog.test.tsx — the three properties the audit trail depends on:
 * it asks, it enforces the minimum, and it cannot be dismissed silently.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReasonDialog } from "./ReasonDialog";

function setup(overrides: Partial<Parameters<typeof ReasonDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ReasonDialog
      open
      title="Change Suresh Gowda's salary"
      description="Monthly CTC ₹24,000.00 → ₹26,500.00"
      actorName="Priya Menon"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel, field: screen.getByLabelText("Reason") };
}

describe("ReasonDialog", () => {
  it("names the change and says the reason is recorded against the admin", () => {
    setup();
    expect(screen.getByText("Change Suresh Gowda's salary")).toBeInTheDocument();
    expect(screen.getByText(/Monthly CTC/)).toBeInTheDocument();
    expect(screen.getByText(/Recorded against Priya Menon\./)).toBeInTheDocument();
  });

  it("keeps Save disabled until the reason is long enough", () => {
    const { field } = setup();
    const save = screen.getByRole("button", { name: /Save with this reason/ });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: "too short" } });
    expect(save).toBeDisabled();
    fireEvent.change(field, { target: { value: "corrected after the signed letter" } });
    expect(save).toBeEnabled();
  });

  it("honours a raised minimum for a D-21 action", () => {
    const { field } = setup({ minLength: 15 });
    fireEvent.change(field, { target: { value: "ten chars." } });
    expect(screen.getByRole("button", { name: /Save with this reason/ })).toBeDisabled();
    expect(screen.getByText(/At least 15 characters/)).toBeInTheDocument();
  });

  it("hands the TRIMMED reason to the caller", () => {
    const { field, onConfirm } = setup();
    fireEvent.change(field, { target: { value: "  bank details corrected from the passbook  " } });
    fireEvent.click(screen.getByRole("button", { name: /Save with this reason/ }));
    expect(onConfirm).toHaveBeenCalledWith("bank details corrected from the passbook");
  });

  it("cannot be dismissed silently once something has been typed", () => {
    const { field, onCancel } = setup();
    fireEvent.change(field, { target: { value: "half a thought" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText(/Use Cancel to discard/)).toBeInTheDocument();
    // The explicit route out still works.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("lets Escape close an untouched dialog rather than trapping the keyboard", () => {
    const { field, onCancel } = setup();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("surfaces a server rejection inside the dialog instead of closing it", () => {
    setup({ errorMessage: "That value is already used on another record." });
    expect(screen.getByRole("alert")).toHaveTextContent(/already used/);
  });

  it("locks both buttons while the write is in flight", () => {
    const { field } = setup({ pending: true });
    expect(field).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();
  });
});
