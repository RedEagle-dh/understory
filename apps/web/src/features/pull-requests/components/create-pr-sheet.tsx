import { type QueryClient, useQueryClient } from "@tanstack/react-query"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { Input } from "@workspace/ui/components/input"
import { Separator } from "@workspace/ui/components/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"
import {
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  OctagonX,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { CopyButton } from "@/components/common/copy-button"
import { SeverityBadge } from "@/components/common/severity-badge"
import { VersionDelta } from "@/components/common/version-delta"
import { usePermissions } from "@/features/auth/use-permissions"
import type { DependencyRow } from "@/features/dependencies/columns"
import { ApiError } from "@/lib/api-error"
import { qk } from "@/lib/query-keys"
import {
  type PrPlan,
  type PrSeedSelection,
  toApiSelections,
  useCreatePr,
  usePlanPr,
} from "../api"
import { useCreatePrFlow } from "../create-pr-context"
import { type BumpOption, BumpPicker } from "./bump-picker"

interface WizardSelection extends PrSeedSelection {
  key: string
}

type WizardStep = "select" | "preview" | "result"

function keyFor(name: string, workspace: string | undefined): string {
  return `${workspace ?? ""}:${name}`
}

function lookupLatestVersion(
  queryClient: QueryClient,
  projectId: string,
  name: string,
  workspace: string | undefined
): string | undefined {
  const entries = queryClient.getQueriesData<{ items: DependencyRow[] }>({
    queryKey: qk.dependencies(projectId),
  })
  for (const [, data] of entries) {
    if (data === undefined) continue
    const row = data.items.find(
      (item) =>
        item.name === name &&
        (workspace === undefined || item.workspace === workspace)
    )
    if (row?.latestVersion) return row.latestVersion
  }
  return undefined
}

/**
 * Options derive from the dependencies list cache when available (a
 * `latest` target), plus whatever concrete version the row was seeded with
 * (a `fix version` from an advisory, or `latest` from the dependencies
 * table / detail sheet). When neither is known, BumpPicker falls back to a
 * "resolved by plan" note — the toVersion stays unset and the plan endpoint
 * picks a target server-side.
 */
function bumpOptionsFor(
  item: WizardSelection,
  queryClient: QueryClient,
  projectId: string
): BumpOption[] {
  const latest = lookupLatestVersion(
    queryClient,
    projectId,
    item.name,
    item.workspace
  )
  const options: BumpOption[] = []
  const seen = new Set<string>()

  if (item.toVersion !== undefined) {
    const label =
      item.hint === "fix"
        ? `fix version (${item.toVersion})`
        : item.hint === "latest"
          ? `latest (${item.toVersion})`
          : item.toVersion
    options.push({ value: item.toVersion, label })
    seen.add(item.toVersion)
  }

  if (latest !== undefined && !seen.has(latest)) {
    options.push({ value: latest, label: `latest (${latest})` })
  }

  return options
}

const STEPS: { id: WizardStep; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "preview", label: "Preview" },
  { id: "result", label: "Create" },
]

function Stepper({ step }: { step: WizardStep }) {
  const currentIndex = STEPS.findIndex((entry) => entry.id === step)

  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      {STEPS.map((entry, index) => (
        <div key={entry.id} className="flex items-center gap-2">
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full border font-heading text-[10px]",
              index === currentIndex
                ? "border-primary bg-primary text-primary-foreground"
                : index < currentIndex
                  ? "border-severity-low/50 text-severity-low"
                  : "border-border text-muted-foreground"
            )}
          >
            {index + 1}
          </span>
          <span
            className={cn(
              "text-xs",
              index === currentIndex
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            )}
          >
            {entry.label}
          </span>
          {index < STEPS.length - 1 && (
            <div className="h-px w-6 bg-border" aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  )
}

function PlanItemsList({ plan }: { plan: PrPlan }) {
  const included = plan.items.filter((item) => item.status !== "dropped")
  const dropped = plan.items.filter((item) => item.status === "dropped")

  return (
    <div className="flex flex-col gap-3">
      {included.length > 0 && (
        <div className="flex flex-col gap-2">
          {included.map((item) => (
            <div
              key={`${item.workspace}:${item.packageName}`}
              className="rounded-md border p-2.5 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-heading text-sm">{item.packageName}</span>
                <Badge variant="outline" className="font-heading">
                  {item.status === "changesManifest"
                    ? "manifest"
                    : "lockfile only"}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {item.workspace !== "" && (
                  <Badge variant="outline" className="font-heading">
                    {item.workspace}
                  </Badge>
                )}
                {item.fromVersion !== null && item.toVersion !== null ? (
                  <VersionDelta
                    current={item.fromVersion}
                    target={item.toVersion}
                    updateKind={item.updateKind}
                  />
                ) : (
                  <span className="font-heading text-muted-foreground">
                    {item.toVersion ?? "—"}
                  </span>
                )}
                {item.newRange !== null && (
                  <span className="font-heading text-muted-foreground">
                    range {item.newRange}
                  </span>
                )}
                {item.severity !== null && (
                  <SeverityBadge severity={item.severity} />
                )}
              </div>
              {item.warnings.length > 0 && (
                <ul className="mt-1.5 list-disc pl-4 text-muted-foreground">
                  {item.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {dropped.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="font-medium text-muted-foreground text-xs">
            Dropped ({dropped.length})
          </p>
          {dropped.map((item) => (
            <div
              key={`${item.workspace}:${item.packageName}`}
              className="rounded-md border border-dashed p-2.5 text-muted-foreground text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-heading">{item.packageName}</span>
                <span>dropped</span>
              </div>
              {item.reason !== null && <p className="mt-1">{item.reason}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface CreatePrSheetProps {
  projectId: string
}

/**
 * Three-step wizard mounted once at the project layout: select packages +
 * targets, preview the rendered PrPlan, then create and watch the result.
 * The plan is the single source of truth for step 2 — it re-runs (debounced)
 * every time a selection changes, so "preview" always reflects what
 * `create` will actually do.
 */
export function CreatePrSheet({ projectId }: CreatePrSheetProps) {
  const flow = useCreatePrFlow()
  const permissions = usePermissions()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<WizardStep>("select")
  const [selections, setSelections] = useState<WizardSelection[]>([])
  const [addValue, setAddValue] = useState("")
  const hasPlannedRef = useRef(false)

  const planPr = usePlanPr(projectId)
  const { mutate: planMutate, reset: planReset } = planPr
  const createPr = useCreatePr(projectId)
  const { mutate: createMutate, reset: createReset } = createPr

  // Reset the whole wizard whenever a new flow is opened.
  useEffect(() => {
    if (!flow.open) return
    setStep("select")
    setSelections(
      flow.seed.map((item) => ({
        ...item,
        key: keyFor(item.name, item.workspace),
      }))
    )
    setAddValue("")
    hasPlannedRef.current = false
    planReset()
    createReset()
  }, [flow.open, flow.seed, planReset, createReset])

  const planPayload = useMemo(() => toApiSelections(selections), [selections])

  // Immediately plans on open, then debounces re-plans as selections change.
  useEffect(() => {
    if (!flow.open) return
    if (planPayload.length === 0) return
    if (!hasPlannedRef.current) {
      hasPlannedRef.current = true
      planMutate(planPayload)
      return
    }
    const handle = setTimeout(() => planMutate(planPayload), 400)
    return () => clearTimeout(handle)
  }, [flow.open, planPayload, planMutate])

  if (!permissions.has("createPr")) return null

  const plan = planPr.data

  const updateToVersion = (key: string, toVersion: string) => {
    setSelections((prev) =>
      prev.map((item) => (item.key === key ? { ...item, toVersion } : item))
    )
  }

  const removeItem = (key: string) => {
    setSelections((prev) => prev.filter((item) => item.key !== key))
  }

  const addPackage = () => {
    const name = addValue.trim()
    if (name === "") return
    const key = keyFor(name, undefined)
    setSelections((prev) =>
      prev.some((item) => item.key === key) ? prev : [...prev, { name, key }]
    )
    setAddValue("")
  }

  const handleSubmit = () => {
    setStep("result")
    createMutate(planPayload)
  }

  const submitDisabled =
    plan === undefined ||
    plan.includedCount === 0 ||
    plan.alreadyOpenPr !== null ||
    planPr.isPending ||
    createPr.isPending

  return (
    <Sheet
      open={flow.open}
      onOpenChange={(next) => {
        if (!next) flow.close()
      }}
    >
      <SheetContent className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="font-heading text-lg">
            Create pull request
          </SheetTitle>
          <SheetDescription>
            Select packages and targets, preview the branch and manifest
            changes, then open the pull request.
          </SheetDescription>
        </SheetHeader>

        <Stepper step={step} />
        <Separator />

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {step === "select" && (
            <div className="flex flex-col gap-2">
              {selections.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No packages selected yet. Add one below.
                </p>
              )}
              {selections.map((item) => {
                const options = bumpOptionsFor(item, queryClient, projectId)
                return (
                  <div
                    key={item.key}
                    className="flex items-center gap-2 rounded-md border p-2"
                  >
                    <span className="min-w-0 flex-1 truncate font-heading text-sm">
                      {item.name}
                    </span>
                    {item.workspace !== undefined && item.workspace !== "" && (
                      <Badge
                        variant="outline"
                        className="shrink-0 font-heading"
                      >
                        {item.workspace}
                      </Badge>
                    )}
                    <BumpPicker
                      value={item.toVersion ?? options[0]?.value}
                      options={options}
                      onChange={(value) => updateToVersion(item.key, value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => removeItem(item.key)}
                      aria-label={`Remove ${item.name}`}
                    >
                      <X />
                    </Button>
                  </div>
                )
              })}

              <div className="mt-2 flex items-center gap-2">
                <Input
                  value={addValue}
                  onChange={(event) => setAddValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addPackage()
                    }
                  }}
                  placeholder="Package name"
                  className="h-8"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addPackage}
                  disabled={addValue.trim() === ""}
                >
                  Add package
                </Button>
              </div>
            </div>
          )}

          {step === "preview" && (
            <div className="flex flex-col gap-4">
              {plan === undefined ? (
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <Spinner className="size-3.5" />
                  Building plan…
                </div>
              ) : (
                <>
                  {planPr.isPending && (
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      <Spinner className="size-3.5" />
                      Re-planning…
                    </div>
                  )}

                  {plan.alreadyOpenPr !== null && (
                    <Alert>
                      <AlertTitle>A pull request is already open</AlertTitle>
                      <AlertDescription>
                        {plan.alreadyOpenPr.url !== null ? (
                          <a
                            href={plan.alreadyOpenPr.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1"
                          >
                            #{plan.alreadyOpenPr.number} on{" "}
                            <span className="font-heading">
                              {plan.alreadyOpenPr.branch}
                            </span>
                            <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <>
                            Branch{" "}
                            <span className="font-heading">
                              {plan.alreadyOpenPr.branch}
                            </span>{" "}
                            is already being created.
                          </>
                        )}
                      </AlertDescription>
                    </Alert>
                  )}

                  <div>
                    <p className="text-muted-foreground text-xs">Title</p>
                    <p className="font-heading text-sm">{plan.title}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 font-heading text-xs">
                    <span>{plan.branch}</span>
                    <span className="text-muted-foreground">→</span>
                    <span className="text-muted-foreground">
                      {plan.baseBranch}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {(["critical", "high", "moderate", "low"] as const).map(
                      (severity) =>
                        plan.severityCounts[severity] > 0 && (
                          <SeverityBadge
                            key={severity}
                            severity={severity}
                            count={plan.severityCounts[severity]}
                          />
                        )
                    )}
                    <span className="font-heading text-muted-foreground text-xs">
                      {plan.includedCount} included · {plan.droppedCount}{" "}
                      dropped
                    </span>
                  </div>

                  <PlanItemsList plan={plan} />

                  <p className="text-muted-foreground text-xs">
                    {plan.lockfileRegenPlanned
                      ? "Lockfile will be regenerated."
                      : "Lockfile will not be regenerated."}
                    {plan.lockfileNote !== null && ` ${plan.lockfileNote}`}
                  </p>

                  {plan.warnings.length > 0 && (
                    <Alert>
                      <AlertTitle>Warnings</AlertTitle>
                      <AlertDescription>
                        <ul className="list-disc pl-4">
                          {plan.warnings.map((warning, index) => (
                            <li key={index}>{warning}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  )}

                  <Collapsible>
                    <CollapsibleTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="w-fit gap-1 px-0"
                        />
                      }
                    >
                      <ChevronDown className="size-3.5" />
                      PR body preview
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-heading text-xs">
                        {plan.body}
                      </pre>
                    </CollapsibleContent>
                  </Collapsible>
                </>
              )}
            </div>
          )}

          {step === "result" && (
            <div className="flex flex-col items-center gap-4 px-2 py-8 text-center">
              {createPr.isPending && (
                <>
                  <Spinner className="size-6" />
                  <p className="text-muted-foreground text-sm">
                    Opening pull request…
                  </p>
                </>
              )}
              {createPr.isSuccess && (
                <>
                  <CheckCircle2 className="size-8 text-severity-low" />
                  <a
                    href={createPr.data.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 font-heading text-lg hover:underline"
                  >
                    #{createPr.data.number}
                    <ExternalLink className="size-4" />
                  </a>
                  <div className="group flex items-center gap-1 font-heading text-muted-foreground text-xs">
                    {createPr.data.branch}
                    <CopyButton
                      value={createPr.data.branch}
                      label="Copy branch name"
                      className="opacity-100"
                    />
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {createPr.data.lockfileUpdated
                      ? "Lockfile regenerated."
                      : "Lockfile not updated — run npm install before merging."}
                  </p>
                  <Button type="button" variant="outline" onClick={flow.close}>
                    Close
                  </Button>
                </>
              )}
              {createPr.isError && (
                <>
                  <OctagonX className="size-8 text-destructive" />
                  <p className="text-destructive text-sm">
                    {createPr.error instanceof ApiError
                      ? createPr.error.detail
                      : "Something went wrong."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        createReset()
                        setStep("preview")
                      }}
                    >
                      Back
                    </Button>
                    <Button type="button" onClick={handleSubmit}>
                      Retry
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {step !== "result" && (
          <SheetFooter className="flex-row items-center justify-between border-t">
            {step === "preview" ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep("select")}
              >
                Back
              </Button>
            ) : (
              <span />
            )}
            {step === "select" && (
              <Button
                type="button"
                onClick={() => setStep("preview")}
                disabled={selections.length === 0}
              >
                Next: Preview
              </Button>
            )}
            {step === "preview" && (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={submitDisabled}
              >
                Open pull request
              </Button>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
