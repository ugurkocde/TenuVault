import type { FeatureTabProps } from "../types"
import StandardsTab from "./StandardsTab"

/** Golden standards (MSP): reusable versioned standards, customer adoptions and portfolio. */
export default function GoldenStandardsTab(props: FeatureTabProps) {
  return <StandardsTab {...props} section="standards" />
}
