export class UpStepError extends Error {
  constructor(number, label, cause, next = 'scorpio up') {
    super(String(cause?.message || cause))
    this.name = 'UpStepError'
    this.number = number
    this.label = label
    this.next = next
  }
}

export async function executeSteps(steps, context, report = () => {}) {
  for (const step of steps) {
    const progress = context.screen?.startStep(step.number, step.label)
    try {
      const existing = await step.check(context)
      if (existing?.done) {
        context[step.key] = existing.value
        if (step.after) await step.after(context)
        progress?.finish(true, step.result?.(context))
        continue
      }
      const started = Date.now()
      const value = await step.run(context)
      if (step.verify && !await step.verify(context, value)) throw new Error('The result could not be verified.')
      context[step.key] = value
      if (step.after) await step.after(context)
      progress?.finish(true, step.result?.(context))
      await report({ number: step.number, label: step.label, value, elapsedMs: Date.now() - started })
    } catch (error) {
      progress?.finish(false)
      throw new UpStepError(step.number, step.label, error, step.next)
    }
  }
  return context
}
