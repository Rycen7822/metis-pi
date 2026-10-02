"""Independent standard-schema checks; byte resources have separate boundary tests."""
from jsonschema import Draft202012Validator

def validate_contract(value, schema):
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(value)
