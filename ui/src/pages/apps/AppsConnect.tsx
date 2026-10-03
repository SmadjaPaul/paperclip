import { useQuery } from "@tanstack/react-query";
import { aiConnectionsApi } from "@/api/ai-connections";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { aiProviderSetupPreset, type ToolConnectionCredentialSource } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { consumeSkillSourceReturn, skillSourceReturnPath } from "@/lib/skill-source-connect-return";

export { AccessStep, OAuthConnectStateScreen, type OAuthConnectPhase } from "@/features/connections/ConnectionSetupFlow";

/** Full-page host for the same setup used by inline connection requests. */
export function AppsConnect({ byoOnly = false, credentialSource = "paperclip_vault" }: {
  byoOnly?: boolean;
  credentialSource?: ToolConnectionCredentialSource;
} = {}) {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { appKey } = useParams<{ appKey?: string }>();
  const source = searchParams.get("source") ?? appKey ?? searchParams.get("appKey");
  const reconnectId = searchParams.get("reconnect");
  const preset = aiProviderSetupPreset(source);
  const aiReconnectRequested = Boolean(reconnectId && (preset || ["openai", "anthropic", "xai"].includes(source ?? "")));
  const aiAccounts = useQuery({ queryKey: ["ai-connections", selectedCompanyId], queryFn: () => aiConnectionsApi.list(selectedCompanyId!), enabled: Boolean(selectedCompanyId && aiReconnectRequested) });
  const aiReconnect = aiAccounts.data?.connections.find(c => c.id === reconnectId);
  const returningToSkills = source === "github" && selectedCompanyId && skillSourceReturnPath(selectedCompanyId);
  function returnToSkills() {
    const path = selectedCompanyId && consumeSkillSourceReturn(selectedCompanyId);
    if (path) navigate(path);
  }
  if (aiReconnectRequested && aiAccounts.isPending) return <p role="status">Loading connection…</p>;
  if (aiReconnectRequested && aiAccounts.isError) return <p role="alert">Could not load this connection. Refresh to try again.</p>;
  if (aiReconnectRequested && !aiReconnect) return <p role="alert">This connection is unavailable. Return to Connectors to choose an account.</p>;
  if (selectedCompanyId && (preset || aiReconnect?.routing)) return (
    <AiProviderSetup
      key={reconnectId ?? source}
      companyId={selectedCompanyId}
      reconnect={aiReconnect}
      initialProvider={preset?.provider}
      initialProtocol={preset?.protocol}
      providerLabel={preset?.label}
      onCancel={() => navigate("/apps")}
      onComplete={binding => navigate(`/apps/${binding.connectionId}/permissions`)}
    />
  );
  return <ConnectionSetupFlow byoOnly={byoOnly} credentialSource={credentialSource} host="page"
    onComplete={returningToSkills ? returnToSkills : undefined}
    onCancel={returningToSkills ? returnToSkills : undefined} />;
}
