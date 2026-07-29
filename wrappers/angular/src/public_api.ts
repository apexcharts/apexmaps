/**
 * Package entry point. `public_api.ts` is ng-packagr's conventional name for it.
 *
 * @module public_api
 */

import type { ApexMapsEventName } from 'apexmaps'
import { ApexMapsComponent } from './apexmaps.component'

export { ApexMapsComponent }

/**
 * Fails the build if a core event has no output on the component. The `OUTPUTS`
 * table inside the component pins each field's payload type; this pins the other
 * direction, that every event *has* a field, which is the direction that goes
 * stale when the core grows one.
 */
type MissingOutput = Exclude<ApexMapsEventName, keyof ApexMapsComponent>
const _everyEventHasAnOutput: Record<MissingOutput, never> = {} as Record<MissingOutput, never>
void _everyEventHasAnOutput
