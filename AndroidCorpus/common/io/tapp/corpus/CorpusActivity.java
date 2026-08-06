package io.tapp.corpus;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class CorpusActivity extends Activity {
    private LinearLayout root;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        String app = getPackageName();
        if (app.endsWith("login")) showLogin();
        else if (app.endsWith("shop")) showShopHome();
        else showGetStarted();
    }

    private void screen(String title) {
        ScrollView scroll = new ScrollView(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 80, 48, 48);
        scroll.addView(root, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextSize(30);
        heading.setTextColor(Color.rgb(20, 24, 35));
        heading.setContentDescription("screen:" + title);
        heading.setPadding(0, 0, 0, 24);
        root.addView(heading, fullWidth());
        setTitle(title);
        setContentView(scroll);
    }

    private LinearLayout.LayoutParams fullWidth() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(0, 10, 0, 10);
        return p;
    }

    private TextView text(String value) {
        TextView v = new TextView(this);
        v.setText(value);
        v.setTextSize(18);
        v.setTextColor(Color.DKGRAY);
        v.setPadding(0, 8, 0, 8);
        root.addView(v, fullWidth());
        return v;
    }

    private Button button(String label, String identifier, View.OnClickListener action) {
        Button b = new Button(this);
        b.setText(label);
        b.setContentDescription(identifier);
        b.setOnClickListener(action);
        root.addView(b, fullWidth());
        return b;
    }

    private EditText field(String hint, String identifier, boolean secure) {
        EditText f = new EditText(this);
        f.setHint(hint);
        f.setContentDescription(identifier);
        f.setSingleLine(true);
        f.setInputType(secure ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD :
            hint.toLowerCase().contains("email") ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS : InputType.TYPE_CLASS_TEXT);
        root.addView(f, fullWidth());
        return f;
    }

    private void showGetStarted() {
        screen("Get Started");
        text("Tapp Android corpus");
        text("A native onboarding surface used to verify deterministic exploration and replay.");
        button("Continue", "continue_button", v -> showDashboard());
    }

    private void showDashboard() {
        screen("Dashboard");
        text("Welcome back").setContentDescription("welcome_message");
        text("3 active projects");
        button("Daily Summary", "summary_button", v -> showSummary());
        button("Settings", "settings_tab", v -> showSettings());
    }

    private void showSummary() {
        screen("Daily Summary");
        text("All systems operational").setContentDescription("summary_status");
        button("Back to Dashboard", "dashboard_button", v -> showDashboard());
    }

    private void showSettings() {
        screen("Settings");
        text("Notifications enabled").setContentDescription("notification_status");
        button("About", "about_button", v -> { screen("About"); text("Tapp Android Demo 1.0"); button("Done", "done_button", x -> showSettings()); });
        button("Dashboard", "dashboard_tab", v -> showDashboard());
    }

    private void showLogin() {
        screen("Sign In");
        text("Use any non-empty corpus credentials.");
        EditText email = field("Email", "email_field", false);
        EditText password = field("Password", "password_field", true);
        TextView error = text("");
        error.setContentDescription("login_error");
        button("Sign In", "sign_in_button", v -> {
            if (email.getText().length() == 0 || password.getText().length() == 0) error.setText("Email and password are required");
            else showLoginDashboard(email.getText().toString());
        });
    }

    private void showLoginDashboard(String email) {
        screen("Home");
        text("Signed in as " + email).setContentDescription("account_summary");
        button("Profile", "profile_button", v -> { screen("Profile"); text(email).setContentDescription("profile_email"); button("Home", "home_button", x -> showLoginDashboard(email)); });
        button("Sign Out", "sign_out_button", v -> showLogin());
    }

    private void showShopHome() {
        screen("Shop");
        text("Featured products");
        text("Trail Backpack — $79").setContentDescription("trail_backpack_card");
        button("View Trail Backpack", "product_trail_backpack", v -> showProduct());
        button("Cart", "cart_button", v -> showCart(false));
    }

    private void showProduct() {
        screen("Trail Backpack");
        text("Weather-resistant day pack").setContentDescription("product_description");
        text("$79").setContentDescription("product_price");
        button("Add to Cart", "add_to_cart_button", v -> showCart(true));
        button("Back to Shop", "shop_button", v -> showShopHome());
    }

    private void showCart(boolean hasItem) {
        screen("Cart");
        if (hasItem) {
            text("Trail Backpack").setContentDescription("cart_item");
            text("Total $79").setContentDescription("cart_total");
            button("Checkout", "checkout_button", v -> showCheckout());
        } else text("Your cart is empty").setContentDescription("empty_cart");
        button("Continue Shopping", "continue_shopping_button", v -> showShopHome());
    }

    private void showCheckout() {
        screen("Checkout");
        EditText name = field("Full Name", "name_field", false);
        EditText address = field("Address", "address_field", false);
        TextView error = text("");
        error.setContentDescription("checkout_error");
        button("Place Test Order", "place_order_button", v -> {
            if (name.getText().length() == 0 || address.getText().length() == 0) error.setText("Shipping details are required");
            else { screen("Order Confirmed"); text("Order TAPP-1001").setContentDescription("order_number"); button("Return to Shop", "return_shop_button", x -> showShopHome()); }
        });
    }
}
