import { get } from "svelte/store"
import {
  routeStore,
  builderStore,
  confirmationStore,
  authStore,
  stateStore,
} from "stores"
import { saveRow, deleteRow, executeQuery, triggerAutomation } from "api"
import { ActionTypes } from "constants"
import { enrichDataBindings } from "./enrichDataBinding"
import { deepSet } from "@budibase/bbui"

const saveRowHandler = async (action, context) => {
  const { fields, providerId, tableId } = action.parameters
  let payload
  if (providerId) {
    payload = { ...context[providerId] }
  } else {
    payload = {}
  }
  if (fields) {
    for (let [field, value] of Object.entries(fields)) {
      deepSet(payload, field, value)
    }
  }
  if (tableId) {
    payload.tableId = tableId
  }
  const row = await saveRow(payload)
  return {
    row,
  }
}

const duplicateRowHandler = async (action, context) => {
  const { fields, providerId, tableId } = action.parameters
  if (providerId) {
    let payload = { ...context[providerId] }
    if (fields) {
      for (let [field, value] of Object.entries(fields)) {
        deepSet(payload, field, value)
      }
    }
    if (tableId) {
      payload.tableId = tableId
    }
    delete payload._id
    delete payload._rev
    const row = await saveRow(payload)
    return {
      row,
    }
  }
}

const deleteRowHandler = async action => {
  const { tableId, revId, rowId } = action.parameters
  if (tableId && revId && rowId) {
    await deleteRow({ tableId, rowId, revId })
  }
}

const triggerAutomationHandler = async action => {
  const { fields } = action.parameters
  if (fields) {
    await triggerAutomation(action.parameters.automationId, fields)
  }
}

const navigationHandler = action => {
  const { url, peek } = action.parameters
  routeStore.actions.navigate(url, peek)
}

const queryExecutionHandler = async action => {
  const { datasourceId, queryId, queryParams } = action.parameters
  const result = await executeQuery({
    datasourceId,
    queryId,
    parameters: queryParams,
  })
  return { result }
}

const executeActionHandler = async (
  context,
  componentId,
  actionType,
  params
) => {
  const fn = context[`${componentId}_${actionType}`]
  if (fn) {
    return await fn(params)
  }
}

const validateFormHandler = async (action, context) => {
  return await executeActionHandler(
    context,
    action.parameters.componentId,
    ActionTypes.ValidateForm,
    action.parameters.onlyCurrentStep
  )
}

const refreshDataProviderHandler = async (action, context) => {
  return await executeActionHandler(
    context,
    action.parameters.componentId,
    ActionTypes.RefreshDatasource
  )
}

const logoutHandler = async action => {
  await authStore.actions.logOut()
  let redirectUrl = "/builder/auth/login"
  let internal = false
  if (action.parameters.redirectUrl) {
    internal = action.parameters.redirectUrl?.startsWith("/")
    redirectUrl = routeStore.actions.createFullURL(
      action.parameters.redirectUrl
    )
  }
  window.location.href = redirectUrl
  if (internal) {
    window.location.reload()
  }
}

const clearFormHandler = async (action, context) => {
  return await executeActionHandler(
    context,
    action.parameters.componentId,
    ActionTypes.ClearForm
  )
}

const changeFormStepHandler = async (action, context) => {
  return await executeActionHandler(
    context,
    action.parameters.componentId,
    ActionTypes.ChangeFormStep,
    action.parameters
  )
}

const closeScreenModalHandler = () => {
  // Emit this as a window event, so parent screens which are iframing us in
  // can close the modal
  window.parent.postMessage({ type: "close-screen-modal" })
}

const updateStateHandler = action => {
  const { type, key, value, persist } = action.parameters
  if (type === "set") {
    stateStore.actions.setValue(key, value, persist)
  } else if (type === "delete") {
    stateStore.actions.deleteValue(key)
  }

  // Emit this as an event so that parent windows which are iframing us in
  // can also update their state
  if (get(routeStore).queryParams?.peek) {
    window.parent.postMessage({
      type: "update-state",
      detail: { type, key, value, persist },
    })
  }
}

const handlerMap = {
  ["Save Row"]: saveRowHandler,
  ["Duplicate Row"]: duplicateRowHandler,
  ["Delete Row"]: deleteRowHandler,
  ["Navigate To"]: navigationHandler,
  ["Execute Query"]: queryExecutionHandler,
  ["Trigger Automation"]: triggerAutomationHandler,
  ["Validate Form"]: validateFormHandler,
  ["Refresh Data Provider"]: refreshDataProviderHandler,
  ["Log Out"]: logoutHandler,
  ["Clear Form"]: clearFormHandler,
  ["Close Screen Modal"]: closeScreenModalHandler,
  ["Change Form Step"]: changeFormStepHandler,
  ["Update State"]: updateStateHandler,
}

const confirmTextMap = {
  ["Delete Row"]: "Are you sure you want to delete this row?",
  ["Save Row"]: "Are you sure you want to save this row?",
  ["Execute Query"]: "Are you sure you want to execute this query?",
  ["Trigger Automation"]: "Are you sure you want to trigger this automation?",
}

/**
 * Parses an array of actions and returns a function which will execute the
 * actions in the current context.
 * A handler returning `false` is a flag to stop execution of handlers
 */
export const enrichButtonActions = (actions, context) => {
  // Prevent button actions in the builder preview
  if (!actions || get(builderStore).inBuilder) {
    return () => {}
  }

  // If this is a function then it has already been enriched
  if (typeof actions === "function") {
    return actions
  }

  // Button context is built up as actions are executed.
  // Inherit any previous button context which may have come from actions
  // before a confirmable action since this breaks the chain.
  let buttonContext = context.actions || []

  const handlers = actions.map(def => handlerMap[def["##eventHandlerType"]])
  return async () => {
    for (let i = 0; i < handlers.length; i++) {
      try {
        // Skip any non-existent action definitions
        if (!handlers[i]) {
          continue
        }

        // Built total context for this action
        const totalContext = { ...context, actions: buttonContext }

        // Get and enrich this button action with the total context
        let action = actions[i]
        action = enrichDataBindings(action, totalContext)
        const callback = async () => handlers[i](action, totalContext)

        // If this action is confirmable, show confirmation and await a
        // callback to execute further actions
        if (action.parameters?.confirm) {
          const defaultText = confirmTextMap[action["##eventHandlerType"]]
          const confirmText = action.parameters?.confirmText || defaultText
          confirmationStore.actions.showConfirmation(
            action["##eventHandlerType"],
            confirmText,
            async () => {
              // When confirmed, execute this action immediately,
              // then execute the rest of the actions in the chain
              const result = await callback()
              if (result !== false) {
                // Generate a new total context to pass into the next enrichment
                buttonContext.push(result)
                const newContext = { ...context, actions: buttonContext }

                // Enrich and call the next button action
                const next = enrichButtonActions(
                  actions.slice(i + 1),
                  newContext
                )
                await next()
              }
            }
          )

          // Stop enriching actions when encountering a confirmable action,
          // as the callback continues the action chain
          return
        }

        // For non-confirmable actions, execute the handler immediately
        else {
          const result = await callback()
          if (result === false) {
            return
          } else {
            buttonContext.push(result)
          }
        }
      } catch (error) {
        console.error("Error while executing button handler")
        console.error(error)
        // Stop executing further actions on error
        return
      }
    }
  }
}
