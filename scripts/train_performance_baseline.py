"""Offline, read-only ML candidate. No database writes, scheduling or model promotion."""
import argparse
import hashlib
import json
import math
import pathlib

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

NUMERIC = ["duration_sec", "motion_intensity", "cut_count", "faces_present",
           "text_overlay_density", "has_voiceover", "has_music", "hour_sin", "hour_cos"]


def frame(rows):
    df = pd.DataFrame(rows).copy()
    df["published_at"] = pd.to_datetime(df["published_at"], utc=True)
    df = df.sort_values(["published_at", "publication_id"]).drop_duplicates("publication_id")
    df = df[df.video_views.notna() & (pd.to_numeric(df.video_views) >= 0) & df.source_id.notna()]
    for col in NUMERIC[:-2]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    hours = df.published_at.dt.tz_convert("America/Los_Angeles").dt.hour
    df["hour_sin"] = np.sin(hours*2*np.pi/24)
    df["hour_cos"] = np.cos(hours*2*np.pi/24)
    df["content_text"] = (df.hook_frame_description.fillna("")+" "+df.on_screen_text_first_3s.fillna(""))
    return df.reset_index(drop=True)


def model():
    features = ColumnTransformer([
        ("numeric", Pipeline([("impute", SimpleImputer(strategy="median", add_indicator=True)),
                              ("scale", StandardScaler())]), NUMERIC),
        ("account", OneHotEncoder(handle_unknown="ignore"), ["phone_slot"]),
        ("content", TfidfVectorizer(max_features=150, min_df=3, ngram_range=(1, 1),
                                    stop_words="english"), "content_text"),
    ])
    return Pipeline([("features", features), ("regression", Ridge(alpha=50, solver="lsqr"))])


def baseline(train, test):
    values = np.log1p(train.video_views.astype(float))
    medians = dict(pd.DataFrame({"account": train.phone_slot, "y": values}).groupby("account").y.median())
    return np.array([medians.get(account, float(np.median(values))) for account in test.phone_slot])


def metrics(truth, pred):
    return {"mae_log1p_views": float(mean_absolute_error(truth, pred)),
            "rmse_log1p_views": float(math.sqrt(mean_squared_error(truth, pred)))}


def fit(data, output):
    df = frame(data["rows"])
    if len(df) < 100:
        raise ValueError("insufficient_fixed_horizon_samples")
    split = int(len(df)*.8)
    test = df.iloc[split:].copy()
    # Exclude all test source videos from training, including cross-account copies.
    train = df.iloc[:split].copy()
    train = train[~train.source_id.isin(set(test.source_id))]
    if len(train) < 80 or len(test) < 30:
        raise ValueError("insufficient_grouped_time_split")
    y_train = np.log1p(train.video_views.astype(float))
    y_test = np.log1p(test.video_views.astype(float))
    candidate = model()
    candidate.fit(train, y_train)
    predictions = candidate.predict(test)
    base_predictions = baseline(train, test)
    measured, reference = metrics(y_test, predictions), metrics(y_test, base_predictions)
    gain = 1 - measured["mae_log1p_views"]/max(reference["mae_log1p_views"], 1e-9)
    # Bootstrap error differences by source rather than treating duplicate sources as independent.
    errors = pd.DataFrame({"source": test.source_id,
                           "difference": np.abs(y_test-base_predictions)-np.abs(y_test-predictions)})
    grouped = errors.groupby("source").difference.mean().to_numpy()
    rng = np.random.default_rng(20261011)
    boot = np.array([rng.choice(grouped, len(grouped), replace=True).mean() for _ in range(2000)])
    ci = np.quantile(boot, [.025,.975]).tolist()
    qualifies = len(test) >= 50 and gain >= .10 and ci[0] > 0
    features = candidate.named_steps["features"].get_feature_names_out()
    coefficients = candidate.named_steps["regression"].coef_
    associations = sorted(zip(features.tolist(), coefficients.tolist()), key=lambda x:abs(x[1]), reverse=True)[:15]
    dataset_hash = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    output.mkdir(parents=True, exist_ok=True)
    if (output/"model.joblib").exists():
        raise ValueError("existing_training_run")
    joblib.dump(candidate, output/"model.joblib")
    report = {
        "model_type": "Ridge regression on log1p views; alpha=50 fixed before evaluation",
        "feature_version": "intrinsic-video-plus-account-hour-v1",
        "dataset_sha256": dataset_hash,
        "outcome": "First observed views between 24 and 30 hours after logged publication attempt",
        "extracted_at": data["extracted_at"],
        "rows": len(df), "train_rows": len(train), "test_rows": len(test),
        "train_end": train.published_at.max().isoformat(), "test_start": test.published_at.min().isoformat(),
        "source_overlap": len(set(train.source_id)&set(test.source_id)),
        "account_coverage": df.phone_slot.value_counts().to_dict(),
        "candidate": measured, "account_median_baseline": reference,
        "relative_mae_improvement": gain,
        "baseline_minus_model_error_source_bootstrap_95pct": ci,
        "qualifies_for_shadow_evaluation": bool(qualifies),
        "promotion_status": "not_promoted_no_production_changes",
        "associations_not_causal": [{"feature": name, "coefficient": value} for name,value in associations],
        "limitations": [
            "Two legacy Instagram accounts only; no linked TikTok labels and no new-account validation.",
            "Only linked, fixed-horizon publications are included; missing outcomes may introduce selection bias.",
            "Intrinsic features can be computed later but must not include observed engagement.",
            "A 24–30h window is not an exact 24h observation; attempt time approximates publication time.",
            "Coefficients show conditional predictive associations, not explanations of why a video went viral.",
            "Transform recipe parameters were not historically logged and are not learned by this baseline.",
            "No controlled A/B test, causal claim, online adaptation or production ranking is enabled.",
            "The held-out set must not be repeatedly used for model selection."
        ]
    }
    (output/"evaluation.json").write_text(json.dumps(report, indent=2))
    pd.DataFrame({"publication_id": test.publication_id,"source_id": test.source_id,
                  "observed_log1p_views":y_test,"predicted_log1p_views":predictions,
                  "baseline_log1p_views":base_predictions}).to_csv(output/"holdout-predictions.csv",index=False)
    print(json.dumps({k:report[k] for k in ["rows","train_rows","test_rows","source_overlap","candidate",
                                         "account_median_baseline","relative_mae_improvement",
                                         "qualifies_for_shadow_evaluation","promotion_status"]}))


if __name__ == "__main__":
    p=argparse.ArgumentParser()
    p.add_argument("dataset",type=pathlib.Path)
    p.add_argument("output",type=pathlib.Path)
    args=p.parse_args()
    fit(json.loads(args.dataset.read_text()),args.output)
