#![allow(dead_code)]

use crate::core::preset::{FolderCondition, VariableDefault};
use std::collections::BTreeMap;

pub fn folder_condition_matches(
    condition: &Option<FolderCondition>,
    variable_values: &BTreeMap<String, String>,
) -> bool {
    let Some(condition) = condition else {
        return true;
    };

    match condition {
        FolderCondition::VariableHasValue { variable_id } => variable_values
            .get(variable_id)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        FolderCondition::VariableEquals { variable_id, value } => variable_values
            .get(variable_id)
            .map(|candidate| default_matches(candidate, value))
            .unwrap_or(false),
    }
}

fn default_matches(candidate: &str, expected: &VariableDefault) -> bool {
    match expected {
        VariableDefault::Text(expected_text) => candidate == expected_text,
        VariableDefault::Bool(expected_bool) => candidate
            .trim()
            .parse::<bool>()
            .map(|candidate_bool| candidate_bool == *expected_bool)
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("campus".to_string(), "KLR".to_string()),
            ("story_name".to_string(), "Baptism".to_string()),
            ("include_audio".to_string(), "true".to_string()),
            ("empty".to_string(), "".to_string()),
        ])
    }

    #[test]
    fn missing_condition_always_matches() {
        assert!(folder_condition_matches(&None, &values()));
    }

    #[test]
    fn variable_has_value_checks_for_non_blank_values() {
        assert!(folder_condition_matches(
            &Some(FolderCondition::VariableHasValue {
                variable_id: "story_name".to_string(),
            }),
            &values(),
        ));

        assert!(!folder_condition_matches(
            &Some(FolderCondition::VariableHasValue {
                variable_id: "empty".to_string(),
            }),
            &values(),
        ));
    }

    #[test]
    fn variable_equals_compares_text_and_boolean_values() {
        assert!(folder_condition_matches(
            &Some(FolderCondition::VariableEquals {
                variable_id: "campus".to_string(),
                value: VariableDefault::Text("KLR".to_string()),
            }),
            &values(),
        ));

        assert!(folder_condition_matches(
            &Some(FolderCondition::VariableEquals {
                variable_id: "include_audio".to_string(),
                value: VariableDefault::Bool(true),
            }),
            &values(),
        ));
    }
}
