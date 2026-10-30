import type { FeatureTabProps } from "../types"
import StandardsTab from "./StandardsTab"

/** Organization customizations (Pro): where this tenant deliberately differs from its baseline. */
export default function CustomizationsTab(props: FeatureTabProps) {
  return <StandardsTab {...props} section="customizations" />
}
