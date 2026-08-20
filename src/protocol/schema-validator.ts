import type { ToolDefinition } from "../openai/types.ts";

export interface SchemaValidationIssue {
	path: string;
	message: string;
}

type JsonSchema = Record<string, unknown>;

type ValidationContext = {
	issues: SchemaValidationIssue[];
	depth: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

function schemaList(value: unknown): JsonSchema[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord);
}

function allowedTypes(schema: JsonSchema): string[] {
	if (typeof schema.type === "string") return [schema.type];
	if (Array.isArray(schema.type)) return schema.type.filter((value): value is string => typeof value === "string");
	return [];
}

function valueMatchesType(value: unknown, type: string): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "array":
			return Array.isArray(value);
		case "object":
			return isRecord(value);
		default:
			return true;
	}
}

function addIssue(ctx: ValidationContext, path: string, message: string): void {
	ctx.issues.push({ path, message });
}

function validateCombinators(value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext): boolean {
	const allOf = schemaList(schema.allOf);
	for (const child of allOf) validateValue(value, child, path, ctx);

	const anyOf = schemaList(schema.anyOf);
	if (anyOf.length > 0) {
		const valid = anyOf.some((child) => validateBranch(value, child, path));
		if (!valid) addIssue(ctx, path, "does not match any allowed schema");
	}

	const oneOf = schemaList(schema.oneOf);
	if (oneOf.length > 0) {
		const matches = oneOf.filter((child) => validateBranch(value, child, path)).length;
		if (matches !== 1) addIssue(ctx, path, `must match exactly one schema (matched ${matches})`);
	}

	if (isRecord(schema.not) && validateBranch(value, schema.not, path)) {
		addIssue(ctx, path, "matches a forbidden schema");
	}

	return ctx.issues.length === 0;
}

function validateBranch(value: unknown, schema: JsonSchema, path: string): boolean {
	const branch: ValidationContext = { issues: [], depth: 0 };
	validateValue(value, schema, path, branch);
	return branch.issues.length === 0;
}

function validateObject(value: Record<string, unknown>, schema: JsonSchema, path: string, ctx: ValidationContext): void {
	const properties = isRecord(schema.properties) ? schema.properties : {};
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((item): item is string => typeof item === "string")
			: [],
	);

	for (const key of required) {
		if (!(key in value)) addIssue(ctx, `${path}.${key}`, "is required");
	}

	for (const [key, childValue] of Object.entries(value)) {
		const childSchema = properties[key];
		if (isRecord(childSchema)) {
			validateValue(childValue, childSchema, `${path}.${key}`, ctx);
			continue;
		}

		if (schema.additionalProperties === false) {
			addIssue(ctx, `${path}.${key}`, "is not an allowed property");
		} else if (isRecord(schema.additionalProperties)) {
			validateValue(childValue, schema.additionalProperties, `${path}.${key}`, ctx);
		}
	}

	if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
		addIssue(ctx, path, `must have at least ${schema.minProperties} properties`);
	}
	if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
		addIssue(ctx, path, `must have at most ${schema.maxProperties} properties`);
	}
}

function validateArray(value: unknown[], schema: JsonSchema, path: string, ctx: ValidationContext): void {
	if (typeof schema.minItems === "number" && value.length < schema.minItems) {
		addIssue(ctx, path, `must contain at least ${schema.minItems} items`);
	}
	if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
		addIssue(ctx, path, `must contain at most ${schema.maxItems} items`);
	}
	if (schema.uniqueItems === true) {
		for (let i = 0; i < value.length; i++) {
			for (let j = i + 1; j < value.length; j++) {
				if (deepEqual(value[i], value[j])) {
					addIssue(ctx, `${path}[${j}]`, "must be unique");
					break;
				}
			}
		}
	}

	if (isRecord(schema.items)) {
		value.forEach((item, index) => validateValue(item, schema.items as JsonSchema, `${path}[${index}]`, ctx));
	}
}

function validateString(value: string, schema: JsonSchema, path: string, ctx: ValidationContext): void {
	if (typeof schema.minLength === "number" && value.length < schema.minLength) {
		addIssue(ctx, path, `must contain at least ${schema.minLength} characters`);
	}
	if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
		addIssue(ctx, path, `must contain at most ${schema.maxLength} characters`);
	}
	if (typeof schema.pattern === "string") {
		try {
			if (!new RegExp(schema.pattern).test(value)) addIssue(ctx, path, `must match pattern ${schema.pattern}`);
		} catch {
			// Invalid provider/tool schemas are treated as non-enforceable here.
		}
	}
}

function validateNumber(value: number, schema: JsonSchema, path: string, ctx: ValidationContext): void {
	if (typeof schema.minimum === "number" && value < schema.minimum) {
		addIssue(ctx, path, `must be >= ${schema.minimum}`);
	}
	if (typeof schema.maximum === "number" && value > schema.maximum) {
		addIssue(ctx, path, `must be <= ${schema.maximum}`);
	}
	if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
		addIssue(ctx, path, `must be > ${schema.exclusiveMinimum}`);
	}
	if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
		addIssue(ctx, path, `must be < ${schema.exclusiveMaximum}`);
	}
}

function validateValue(value: unknown, schema: JsonSchema, path: string, ctx: ValidationContext): void {
	if (ctx.depth > 24) {
		addIssue(ctx, path, "schema nesting exceeds gateway validation limit");
		return;
	}
	ctx.depth += 1;
	try {
		validateCombinators(value, schema, path, ctx);

		if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
			addIssue(ctx, path, "must be one of the declared enum values");
		}
		if ("const" in schema && !deepEqual(schema.const, value)) {
			addIssue(ctx, path, "must equal the declared const value");
		}

		const types = allowedTypes(schema);
		if (types.length > 0 && !types.some((type) => valueMatchesType(value, type))) {
			addIssue(ctx, path, `must be of type ${types.join(" | ")}`);
			return;
		}

		if (isRecord(value)) validateObject(value, schema, path, ctx);
		else if (Array.isArray(value)) validateArray(value, schema, path, ctx);
		else if (typeof value === "string") validateString(value, schema, path, ctx);
		else if (typeof value === "number") validateNumber(value, schema, path, ctx);
	} finally {
		ctx.depth -= 1;
	}
}

export function validateJsonSchema(value: unknown, schema: unknown): SchemaValidationIssue[] {
	if (!isRecord(schema) || Object.keys(schema).length === 0) return [];
	const ctx: ValidationContext = { issues: [], depth: 0 };
	validateValue(value, schema, "$", ctx);
	return ctx.issues;
}

export function validateToolArguments(
	tool: ToolDefinition,
	argumentsValue: Record<string, unknown>,
): SchemaValidationIssue[] {
	return validateJsonSchema(argumentsValue, tool.function.parameters);
}
