/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
// plane imports
import { Button } from "@makeplane/propel/components/button";
import { InputField } from "@makeplane/propel/components/input-field";
import { SelectField } from "@makeplane/propel/components/select-field";
import { PlaneLogo } from "@plane/blocks/icons";
import { useTranslation } from "@plane/i18n";
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
// helpers
import { normalizeUserCode } from "@/helpers/device-code.helper";
// wrappers
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";
// services
import { DeviceService } from "@/services/device.service";

const deviceService = new DeviceService();

type TOutcome = "approved" | "denied" | null;

const DevicePage = observer(function DevicePage() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  // the code from the URL, or the one typed in by the user
  const [typedCode, setTypedCode] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState(false);
  const [workspaceSlug, setWorkspaceSlug] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<TOutcome>(null);
  const [submitError, setSubmitError] = useState(false);

  const userCode = typedCode ?? normalizeUserCode(searchParams.get("user_code"));

  const {
    data: request,
    error: requestError,
    isLoading,
  } = useSWR(userCode ? `DEVICE_REQUEST_${userCode}` : null, () => deviceService.getRequest(userCode!), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const selectedSlug = workspaceSlug ?? request?.workspaces?.[request.workspaces.length - 1]?.slug ?? null;

  const handleCodeSubmit = (e: FormEvent) => {
    e.preventDefault();
    const code = normalizeUserCode(input);
    setInputError(!code);
    if (code) setTypedCode(code);
  };

  const respond = async (action: "approved" | "denied") => {
    if (!userCode || isSubmitting) return;
    setIsSubmitting(true);
    setSubmitError(false);
    try {
      if (action === "approved") await deviceService.approve(userCode, selectedSlug!);
      else await deviceService.deny(userCode);
      setOutcome(action);
    } catch {
      setSubmitError(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetCode = () => {
    setTypedCode(null);
    setInput("");
    setInputError(false);
    // drop a bad user_code from the URL so the input form is shown
    window.history.replaceState(null, "", window.location.pathname);
  };

  let content: React.ReactNode;
  if (outcome) {
    content = (
      <p className="text-body-sm-regular text-secondary">
        {t(outcome === "approved" ? "auth.device.approved" : "auth.device.denied")}
      </p>
    );
  } else if (!userCode) {
    content = (
      <form onSubmit={handleCodeSubmit} className="flex flex-col gap-4">
        <p className="text-body-sm-regular text-secondary">{t("auth.device.enter_code_description")}</p>
        <InputField
          size="xl"
          orientation="vertical"
          label={t("auth.device.code_label")}
          name="user_code"
          type="text"
          autoComplete="off"
          autoFocus
          placeholder={t("auth.device.code_placeholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          error={inputError ? t("auth.device.code_invalid") : undefined}
        />
        <Button stretch="auto" type="submit" variant="primary" size="lg" label={t("auth.device.continue")} />
      </form>
    );
  } else if (isLoading) {
    content = <LogoSpinner />;
  } else if (requestError || !request) {
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-body-sm-regular text-secondary">{t("auth.device.invalid_or_expired")}</p>
        <Button
          stretch="auto"
          variant="secondary"
          size="lg"
          onClick={resetCode}
          label={t("auth.device.try_another_code")}
        />
      </div>
    );
  } else {
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-body-sm-regular text-secondary">
          {t("auth.device.requesting_access", { clientName: request.client_name })}
        </p>
        <p className="font-mono tracking-widest text-h5-semibold text-primary">{request.user_code}</p>
        {request.workspaces.length === 0 ? (
          <p className="text-body-sm-regular text-danger-primary">{t("auth.device.no_workspaces")}</p>
        ) : (
          <SelectField
            size="lg"
            aria-label={t("auth.device.workspace_label")}
            value={selectedSlug}
            onValueChange={(slug) => slug !== null && setWorkspaceSlug(slug)}
            options={request.workspaces.map((workspace) => ({ value: workspace.slug, label: workspace.name }))}
          />
        )}
        {submitError && <p className="text-body-sm-regular text-danger-primary">{t("auth.device.error")}</p>}
        <div className="flex gap-3">
          <Button
            stretch="auto"
            variant="primary"
            size="lg"
            loading={isSubmitting}
            disabled={isSubmitting || !selectedSlug}
            onClick={() => respond("approved")}
            label={t("auth.device.approve")}
          />
          <Button
            stretch="auto"
            variant="secondary"
            size="lg"
            disabled={isSubmitting}
            onClick={() => respond("denied")}
            label={t("auth.device.deny")}
          />
        </div>
      </div>
    );
  }

  return (
    <AuthenticationWrapper>
      <div className="flex h-full min-h-screen flex-col items-center justify-center gap-8 px-6">
        <PlaneLogo className="h-9 w-auto text-primary" />
        <div className="w-full max-w-md space-y-6">
          <h1 className="text-h4-semibold">{t("auth.device.title")}</h1>
          {content}
        </div>
      </div>
    </AuthenticationWrapper>
  );
});

export default DevicePage;
