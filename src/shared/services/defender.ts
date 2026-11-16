import { area, part, type PermissionArea } from "./areas"

/**
 * The areas of Defender with the Microsoft Graph permissions each folder needs, checked and recorded
 * like the Entra ID ones (see ./entra).
 *
 * Cloud scopes and content repositories remain excluded until their read access is verified.
 * Workbooks have a published read contract and a successful application read in the lab.
 */
export const DEFENDER_AREAS: readonly PermissionArea[] = [
  area({ id: "detection", label: "Detection and response" }, [
    part(["DefenderCustomDetectionRules"], [["CustomDetection.Read.All", "CustomDetection.ReadWrite.All"]], [["CustomDetection.Read.All"]], [["CustomDetection.ReadWrite.All"]]),
    part(["DefenderWorkbooks"], [["Workbooks.Read.All"]], [["Workbooks.Read.All"]], "unsupported"),
    // Not restored: Microsoft documents no write for case type configurations.
    part(["DefenderCaseTypeConfigurations"], [["CaseManagement.Read.All", "CaseManagement.ReadWrite.All"]], [["CaseManagement.Read.All"]], "unsupported"),
  ]),
  area({ id: "email", label: "Email and collaboration" }, [
    // Never restored: a restored simulation would start a new campaign.
    part(["DefenderAttackSimulations", "DefenderAttackSimulationAutomations", "DefenderAttackSimulationTrainingCampaigns", "DefenderAttackSimulationPayloads", "DefenderAttackSimulationLandingPages", "DefenderAttackSimulationLoginPages", "DefenderAttackSimulationNotifications"], [["AttackSimulation.Read.All"]], [["AttackSimulation.Read.All"]], "unsupported"),
    part(["DefenderEmailSubmissionPolicies"], [["ThreatSubmission.Read.All", "ThreatSubmission.ReadWrite.All", "ThreatSubmissionPolicy.ReadWrite.All"]], [["ThreatSubmission.Read.All"]], [["ThreatSubmissionPolicy.ReadWrite.All"]]),
  ]),
  area({ id: "identity", label: "Identity" }, [
    part(["DefenderIdentitySensors", "DefenderIdentitySensorActivation"], [["SecurityIdentitiesSensors.Read.All", "SecurityIdentitiesSensors.ReadWrite.All"]], [["SecurityIdentitiesSensors.Read.All"]], [["SecurityIdentitiesSensors.ReadWrite.All"]]),
    part(["DefenderIdentityAutoAuditing"], [["SecurityIdentitiesAutoConfig.Read.All", "SecurityIdentitiesAutoConfig.ReadWrite.All"]], [["SecurityIdentitiesAutoConfig.Read.All"]], [["SecurityIdentitiesAutoConfig.ReadWrite.All"]]),
  ]),
  area({ id: "posture", label: "Posture and access" }, [
    part(["DefenderSecureScoreControlStates"], [["SecurityEvents.Read.All", "SecurityEvents.ReadWrite.All"]], [["SecurityEvents.Read.All"]], [["SecurityEvents.ReadWrite.All"]]),
    part(["DefenderRoleDefinitions", "DefenderRoleAssignments"], [["RoleManagement.Read.Defender", "RoleManagement.ReadWrite.Defender"]], [["RoleManagement.Read.Defender"]], [["RoleManagement.ReadWrite.Defender"]]),
  ]),
]
